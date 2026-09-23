import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import {
  finalizeRefundFailure,
  finalizeRefundSuccess,
  type RefundProviderEvidence,
} from "@/lib/orders/refund";
import {
  enqueueOrderConfirmationEmail,
  enqueuePaymentFailedEmail,
  enqueueReconciliationAlertEmail,
} from "@/lib/email/notifications";
import { scheduleEagerEmailDispatch } from "@/lib/email/eagerDispatch";
import { apiErrorResponse } from "@/lib/http/errors";
import { buildRateLimitKey, consumeRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * Only payment.succeeded has been captured from a real signed ChariPay
 * delivery so far — refund.succeeded/refund.failed field-name casing is
 * still a guess extrapolated from that one confirmed shape (see
 * charipayProvider.ts's parseWebhook comments). Set this true once a real
 * refund.* delivery is captured and parseWebhook is corrected against it;
 * until then refund events are acknowledged but never auto-finalized.
 *
 * TODO(flip-this-flag): CHARIPAY_UNVERIFIED_SHAPE_REPLAY_RATE_LIMIT below
 * only bounds this path while the flag is false. Once flipped, refund
 * events fall through to the isRefundEvent finalize branch, which has no
 * dedicated rate limit of its own — add one alongside flipping this.
 */
const CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED = false;

/**
 * Only payment.succeeded has been captured against a real signed ChariPay
 * delivery so far — payment.failed shares the same guessed Amount/metadata
 * envelope shape purely by extrapolation (see charipayProvider.ts's
 * parseWebhook comments), never independently confirmed. A payment.failed
 * event marks the order/payment failed and releases inventory, so acting
 * on an unverified guess is not acceptable. Set this true once a real
 * payment.failed delivery is captured and parseWebhook is corrected/pinned
 * against it; until then payment.failed events are acknowledged but never
 * auto-finalized, exactly like the refund gate above.
 */
const CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED = false;

const CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT = {
  limit: 6,
  windowMs: 5 * 60 * 1000,
} as const;

const CHARIPAY_UNVERIFIED_SHAPE_REPLAY_RATE_LIMIT = {
  limit: 6,
  windowMs: 5 * 60 * 1000,
} as const;

type WebhookResult =
  | { kind: "duplicate" }
  | { kind: "event_collision" }
  | { kind: "processed"; outcome: string; orderId?: string; refundId?: string; paymentEventId?: string; providerRefundId?: string };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

const CHARIPAY_WEBHOOK_EVIDENCE_VERSION = "charipay_webhook_fingerprint_v1";

function webhookFingerprint(raw: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(raw)).digest("hex");
}

function webhookTopLevelFieldCount(raw: unknown): number {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.keys(raw as Record<string, unknown>).length
    : 0;
}

/**
 * Persist only non-sensitive evidence needed for replay/collision diagnostics.
 * Even JSON property names are provider-controlled and can theoretically carry
 * customer identifiers, so the evidence keeps only a fingerprint and a count.
 * Exact provider bodies/field names remain available from ChariPay's own
 * authenticated webhook-events journal when a new shape must be pinned.
 */
function webhookEvidence(raw: unknown): Prisma.InputJsonObject {
  return {
    version: CHARIPAY_WEBHOOK_EVIDENCE_VERSION,
    fingerprint: webhookFingerprint(raw),
    topLevelFieldCount: webhookTopLevelFieldCount(raw),
  };
}

function storedWebhookFingerprint(rawPayload: unknown): string {
  if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    const object = rawPayload as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (
      keys.length === 3
      && keys[0] === "fingerprint"
      && keys[1] === "topLevelFieldCount"
      && keys[2] === "version"
      && object.version === CHARIPAY_WEBHOOK_EVIDENCE_VERSION
      && typeof object.fingerprint === "string"
      && /^[0-9a-f]{64}$/.test(object.fingerprint)
      && Number.isSafeInteger(object.topLevelFieldCount)
      && (object.topLevelFieldCount as number) >= 0
    ) {
      return object.fingerprint;
    }
  }

  // Backward compatibility: rows written before this hardening contain the
  // full provider JSON. Hash that legacy value on read so an old unprocessed
  // event can still be retried/recognized without a data migration.
  return webhookFingerprint(rawPayload);
}

function consistentClaim(
  existing: { paymentId: string; eventType: string; signatureValid: boolean; rawPayload: unknown },
  paymentId: string,
  event: { type: string; raw: unknown },
): boolean {
  return existing.paymentId === paymentId
    && existing.eventType === event.type
    && existing.signatureValid !== false
    && storedWebhookFingerprint(existing.rawPayload) === webhookFingerprint(event.raw);
}

function isSyntheticTestPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const object = raw as Record<string, unknown>;
  return object.Test === true || object.test === true;
}

async function auditIntegrityMismatch(
  action: string,
  paymentId: string,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: "system",
      action,
      entityType: "Payment",
      entityId: paymentId,
      metadata,
    },
  });
}

async function recordPaymentWebhookStatusAudit(
  action: string,
  paymentId: string,
  externalEventId: string,
  metadata: Prisma.InputJsonObject,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Provider retries can repeat the same temporary status mismatch/outage.
    // Serialize by action + provider event id so retries stay on one audit row
    // while later, more informative provider state can refresh its diagnostics.
    const lockKey = `${action}:${externalEventId}`;
    await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) IS NULL AS locked
    `;

    const existing = await tx.auditLog.findFirst({
      where: {
        action,
        entityType: "Payment",
        entityId: paymentId,
        metadata: { path: ["externalEventId"], equals: externalEventId },
      },
      select: { id: true, metadata: true },
    });

    if (!existing) {
      await tx.auditLog.create({
        data: {
          actorType: "system",
          action,
          entityType: "Payment",
          entityId: paymentId,
          metadata: { externalEventId, occurrences: 1, ...metadata },
        },
      });
      return;
    }

    const previousMetadata =
      existing.metadata
      && typeof existing.metadata === "object"
      && !Array.isArray(existing.metadata)
        ? existing.metadata as Prisma.JsonObject
        : {};
    const previousOccurrences =
      typeof previousMetadata.occurrences === "number"
      && Number.isSafeInteger(previousMetadata.occurrences)
      && previousMetadata.occurrences >= 1
        ? previousMetadata.occurrences
        : 1;

    const firstReason =
      typeof previousMetadata.firstReason === "string"
        ? previousMetadata.firstReason
        : typeof previousMetadata.reason === "string"
          ? previousMetadata.reason
          : typeof metadata.reason === "string"
            ? metadata.reason
            : undefined;
    const firstObservedProviderStatus =
      typeof previousMetadata.firstObservedProviderStatus === "string"
        ? previousMetadata.firstObservedProviderStatus
        : typeof previousMetadata.observedProviderStatus === "string"
          ? previousMetadata.observedProviderStatus
          : typeof metadata.observedProviderStatus === "string"
            ? metadata.observedProviderStatus
            : undefined;

    await tx.auditLog.update({
      where: { id: existing.id },
      data: {
        metadata: {
          externalEventId,
          occurrences: previousOccurrences + 1,
          ...(firstReason ? { firstReason } : {}),
          ...(firstObservedProviderStatus ? { firstObservedProviderStatus } : {}),
          ...metadata,
        },
      },
    });
  });
}

async function recordPaymentWebhookVerificationRateLimited(
  paymentId: string,
  eventType: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const action = "payment.webhook_status_verification_rate_limited";
    const lockKey = `${action}:${paymentId}`;
    await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) IS NULL AS locked
    `;

    const existing = await tx.auditLog.findFirst({
      where: {
        action,
        entityType: "Payment",
        entityId: paymentId,
      },
      select: { id: true, metadata: true },
    });

    const observedAt = new Date().toISOString();
    if (!existing) {
      await tx.auditLog.create({
        data: {
          actorType: "system",
          action,
          entityType: "Payment",
          entityId: paymentId,
          metadata: {
            occurrences: 1,
            firstEventType: eventType,
            latestEventType: eventType,
            limit: CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT.limit,
            windowMs: CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT.windowMs,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
          },
        },
      });
      return;
    }

    const previousMetadata =
      existing.metadata
      && typeof existing.metadata === "object"
      && !Array.isArray(existing.metadata)
        ? existing.metadata as Prisma.JsonObject
        : {};
    const previousOccurrences =
      typeof previousMetadata.occurrences === "number"
      && Number.isSafeInteger(previousMetadata.occurrences)
      && previousMetadata.occurrences >= 1
        ? previousMetadata.occurrences
        : 1;
    const firstEventType =
      typeof previousMetadata.firstEventType === "string"
        ? previousMetadata.firstEventType
        : eventType;
    const firstObservedAt =
      typeof previousMetadata.firstObservedAt === "string"
        ? previousMetadata.firstObservedAt
        : observedAt;

    await tx.auditLog.update({
      where: { id: existing.id },
      data: {
        metadata: {
          occurrences: previousOccurrences + 1,
          firstEventType,
          latestEventType: eventType,
          limit: CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT.limit,
          windowMs: CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT.windowMs,
          firstObservedAt,
          lastObservedAt: observedAt,
        },
      },
    });
  });
}

export async function POST(request: NextRequest) {
  try {
    // This provider-specific endpoint must keep accepting historical ChariPay
    // events even if PAYMENT_PROVIDER later changes for newly-created payments.
    const provider = getPaymentProviderByName("charipay");
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    const event = await provider.parseWebhook({ rawBody, headers });
    if (!event.signatureValid) {
      console.info("charipay webhook rejected: invalid signature", {
        hasSignature: Boolean(headers["x-chari-signature"]),
        hasTimestamp: Boolean(headers["x-chari-timestamp"]),
        hasEventId: Boolean(headers["chari-event-id"]),
        eventType: headers["chari-event-type"] ?? null,
        bodyLength: rawBody.length,
      });
      return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    }

    // ChariPay's dashboard can send a signed synthetic delivery that is not
    // associated with a real OnlyLive Payment. Acknowledge it without mutation.
    if (isSyntheticTestPayload(event.raw)) {
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "charipay.webhook_test_received",
          entityType: "PaymentProvider",
          entityId: "charipay",
          metadata: { externalEventId: event.externalEventId || null },
        },
      });
      return NextResponse.json({ ok: true, test: true });
    }

    const isRefundEvent = event.type === "refund.succeeded" || event.type === "refund.failed";

    const hitsUnverifiedShapeGate =
      (isRefundEvent && !CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED && Boolean(event.externalEventId))
      || (
        headers["chari-event-type"] === "payment.failed"
        && event.type === "payment.failed"
        && !CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED
        && Boolean(event.externalEventId)
      );
    if (hitsUnverifiedShapeGate) {
      const replayBudget = await consumeRateLimit(
        buildRateLimitKey(
          "charipay_shape_replay",
          webhookFingerprint(event.raw),
        ),
        CHARIPAY_UNVERIFIED_SHAPE_REPLAY_RATE_LIMIT,
      );
      if (!replayBudget.allowed) {
        return NextResponse.json(
          {
            ok: true,
            reconciliationRequired: true,
            replayRateLimited: true,
          },
          { status: 202 },
        );
      }
    }

    // This must run BEFORE the generic payloadValid gate below: payloadValid
    // itself depends on the unverified guessed refund fields (RefundAmount/
    // refundAmount, refundExternalId's PascalCase/lowercase fallbacks), so a
    // real refund webhook whose actual shape differs from that guess would
    // otherwise be rejected with 400 INVALID_PROVIDER_PAYLOAD instead of
    // being acknowledged here — exactly the "never invent provider fields"
    // violation this gate exists to prevent. Only already-confirmed envelope
    // facts (a recognized event type, a present event id — both resolved by
    // parseWebhook independently of the guessed body-field shape) gate this
    // branch. Finalizing a refund from a guessed shape would risk a silent
    // amount/reference mismatch on real money movement, so fail closed:
    // acknowledge so ChariPay stops retrying, but require authenticated
    // provider-status reconciliation (lib/orders/refundReconciliation.ts's
    // getRefundStatus() poll) or manual attention instead of auto-finalizing
    // from this webhook. Flip CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED once a
    // real refund.* delivery is captured and parseWebhook is corrected
    // against it.
    if (isRefundEvent && !CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED && event.externalEventId) {
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.webhook_shape_unverified",
          entityType: "PaymentProvider",
          entityId: provider.name,
          metadata: {
            externalEventId: event.externalEventId,
            eventType: event.type,
            payloadEvidence: webhookEvidence(event.raw),
          },
        },
      });
      return NextResponse.json({ ok: true, reconciliationRequired: true }, { status: 202 });
    }

    // Same reasoning as the refund gate above, and must run before it for
    // the same reason: payloadValid for payment.* events depends on the
    // unverified guessed Amount/metadata shape (charipayProvider.ts's
    // parseWebhook — only payment.succeeded has been captured from a real
    // delivery), so checking it first would 400-reject a real
    // payment.failed whose actual shape differs from the guess instead of
    // acknowledging it here. This gate keys only on already-confirmed
    // envelope facts (a recognized event type, a present event id) — no
    // Payment row needs to be resolved. Dedup against AuditLog by
    // externalEventId (rather than provider.name, unlike the refund gate)
    // because this is the only reliable idempotency key available this
    // early: payment_events requires an already-resolved payment_id, which
    // this gate deliberately never resolves from an unverified body shape.
    if (
      headers["chari-event-type"] === "payment.failed"
      && event.type === "payment.failed"
      && !CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED
      && event.externalEventId
    ) {
      await prisma.$transaction(async (tx) => {
        // AuditLog has no uniqueness constraint suitable for this one special
        // evidence action. Serialize by provider event id so two concurrent
        // deliveries cannot both pass a read-then-create race and violate the
        // exactly-once evidence guarantee.
        await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_advisory_xact_lock(hashtextextended(${event.externalEventId}, 0)) IS NULL AS locked
        `;
        const alreadyRecorded = await tx.auditLog.findFirst({
          where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: event.externalEventId },
        });
        if (!alreadyRecorded) {
          await tx.auditLog.create({
            data: {
              actorType: "system",
              action: "charipay.payment_failed_shape_unverified",
              entityType: "PaymentProviderEvent",
              entityId: event.externalEventId,
              metadata: {
                provider: provider.name,
                eventType: event.type,
                payloadEvidence: webhookEvidence(event.raw),
              },
            },
          });
        }
      });
      return NextResponse.json({ ok: true, reconciliationRequired: true }, { status: 202 });
    }

    if (!event.payloadValid) {
      const rawKeys = event.raw && typeof event.raw === "object" && !Array.isArray(event.raw)
        ? Object.keys(event.raw as Record<string, unknown>).sort()
        : [];
      console.info("charipay webhook rejected: invalid payload", {
        externalEventIdPresent: Boolean(event.externalEventId),
        eventType: headers["chari-event-type"] ?? null,
        providerPaymentIdPresent: Boolean(event.providerPaymentId),
        paymentExternalIdPresent: Boolean(event.paymentExternalId),
        amountCents: event.amountCents,
        currency: event.currency,
        rawKeys,
      });
      return NextResponse.json({ error: "INVALID_PROVIDER_PAYLOAD" }, { status: 400 });
    }

    let refund = null as Awaited<ReturnType<typeof prisma.refund.findUnique>>;
    let payment = null as Awaited<ReturnType<typeof prisma.payment.findUnique>>;

    if (isRefundEvent) {
      if (!event.refundExternalId) {
        return NextResponse.json({ error: "REFUND_REFERENCE_MISSING" }, { status: 400 });
      }
      refund = await prisma.refund.findUnique({ where: { id: event.refundExternalId } });
      if (!refund) {
        // A refund initiated directly in the provider portal/API is authentic
        // but has no local Refund row. Persist the anomaly before acknowledging
        // so ChariPay does not retry the same non-actionable event forever.
        await prisma.auditLog.create({
          data: {
            actorType: "system",
            action: "refund.provider_unknown",
            entityType: "Refund",
            entityId: event.refundExternalId,
            metadata: {
              provider: provider.name,
              externalEventId: event.externalEventId,
              providerRefundId: event.providerRefundId ?? null,
              amountCents: event.amountCents,
              currency: event.currency,
            },
          },
        });
        return NextResponse.json({ ok: true, reconciliationRequired: true }, { status: 202 });
      }
      payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
      if (!payment || payment.provider !== provider.name) {
        return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
      }

      const mismatch =
        event.amountCents !== refund.amountCents
        || payment.currency !== "MAD"
        || event.currency !== payment.currency
        || (event.paymentExternalId !== undefined && event.paymentExternalId !== payment.id)
        || (event.orderExternalId !== undefined && event.orderExternalId !== payment.orderId)
        || (event.providerPaymentId !== "" && payment.providerPaymentId !== event.providerPaymentId)
        || (event.providerRefundId !== undefined
          && refund.providerRefundId !== null
          && refund.providerRefundId !== event.providerRefundId);
      if (mismatch) {
        await auditIntegrityMismatch("refund.webhook_integrity_mismatch", payment.id, {
          refundId: refund.id,
          externalEventId: event.externalEventId,
          expectedAmountCents: refund.amountCents,
          receivedAmountCents: event.amountCents,
          expectedCurrency: payment.currency,
          receivedCurrency: event.currency,
        });
        return NextResponse.json({ error: "REFUND_INTEGRITY_MISMATCH" }, { status: 409 });
      }
    } else {
      payment = event.paymentExternalId
        ? await prisma.payment.findFirst({ where: { id: event.paymentExternalId, provider: provider.name } })
        : null;
      if (!payment && event.providerPaymentId) {
        payment = await prisma.payment.findUnique({
          where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: event.providerPaymentId } },
        });
      }
      if (!payment) return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });

      const mismatch =
        event.amountCents !== payment.amountCents
        || payment.currency !== "MAD"
        || event.currency !== payment.currency
        || (event.paymentExternalId !== undefined && event.paymentExternalId !== payment.id)
        || (event.orderExternalId !== undefined && event.orderExternalId !== payment.orderId)
        || (event.providerPaymentId !== "" && payment.providerPaymentId !== event.providerPaymentId);
      if (mismatch) {
        await auditIntegrityMismatch("payment.amount_mismatch", payment.id, {
          expectedAmountCents: payment.amountCents,
          expectedCurrency: payment.currency,
          receivedAmountCents: event.amountCents,
          receivedCurrency: event.currency,
          externalEventId: event.externalEventId,
        });
        return NextResponse.json({ error: "AMOUNT_MISMATCH" }, { status: 409 });
      }
    }

    if (!isRefundEvent) {
      // ChariPay signs timestamp + "." + rawBody; Chari-Event-Type and
      // Chari-Event-Id are separate headers and are not covered by that HMAC.
      // An identical already-processed event is safe to acknowledge without a
      // provider API call. Any new/unprocessed financial event must have its
      // header-claimed outcome independently confirmed by the authenticated,
      // already-pinned transaction ledger before it may mutate orders/tickets.
      const existingEvent = await prisma.paymentEvent.findUnique({
        where: {
          provider_externalEventId: {
            provider: provider.name,
            externalEventId: event.externalEventId,
          },
        },
      });
      if (
        existingEvent
        && existingEvent.processedAt !== null
        && consistentClaim(existingEvent, payment.id, event)
      ) {
        return NextResponse.json({ ok: true, duplicate: true });
      }

      const lookupPaymentStatus = provider.lookupPaymentStatus?.bind(provider);
      if (!lookupPaymentStatus) {
        await recordPaymentWebhookStatusAudit(
          "payment.webhook_status_verification_unavailable",
          payment.id,
          event.externalEventId,
          {
            eventType: event.type,
            reason: "provider_lookup_not_supported",
          },
        );
        return NextResponse.json(
          { error: "PROVIDER_STATUS_VERIFICATION_UNAVAILABLE" },
          { status: 503 },
        );
      }

      const verificationBudget = await consumeRateLimit(
        buildRateLimitKey(
          "charipay_webhook_verify",
          `${payment.id}:${webhookFingerprint(event.raw)}`,
        ),
        CHARIPAY_WEBHOOK_STATUS_VERIFY_RATE_LIMIT,
      );
      if (!verificationBudget.allowed) {
        await recordPaymentWebhookVerificationRateLimited(payment.id, event.type);
        return NextResponse.json(
          {
            ok: true,
            reconciliationRequired: true,
            verificationRateLimited: true,
          },
          { status: 202 },
        );
      }

      let providerStatus: Awaited<ReturnType<typeof lookupPaymentStatus>>;
      try {
        providerStatus = await lookupPaymentStatus({
          orderExternalId: payment.orderId,
          amountCents: payment.amountCents,
          currency: payment.currency,
          // ChariPay warns that ~10s webhook handlers trigger redeliveries and
          // can eventually suspend an endpoint. Keep the synchronous ledger
          // verification comfortably below that delivery budget; a timeout
          // fails closed with 503 and is safe for provider retry.
          requestTimeoutMs: 5_000,
        });
      } catch {
        await recordPaymentWebhookStatusAudit(
          "payment.webhook_status_verification_unavailable",
          payment.id,
          event.externalEventId,
          {
            eventType: event.type,
            reason: "provider_lookup_failed",
          },
        );
        return NextResponse.json(
          { error: "PROVIDER_STATUS_VERIFICATION_UNAVAILABLE" },
          { status: 503 },
        );
      }

      const expectedProviderStatus =
        event.type === "payment.succeeded"
          ? "succeeded"
          : event.type === "payment.failed"
            ? "failed"
            : null;

      if (expectedProviderStatus && providerStatus.status !== expectedProviderStatus) {
        await recordPaymentWebhookStatusAudit(
          "payment.webhook_header_status_mismatch",
          payment.id,
          event.externalEventId,
          {
            eventType: event.type,
            expectedProviderStatus,
            observedProviderStatus: providerStatus.status,
          },
        );

        // A terminal opposite outcome is a real contradiction, not a
        // transient lookup failure. Acknowledge it so a relabeled/replayed
        // signed body cannot jam the provider queue, but never mutate local
        // financial state from the unbound header. Human/provider-status
        // reconciliation owns the contradiction from here.
        const terminalContradiction =
          (event.type === "payment.succeeded"
            && (providerStatus.status === "failed" || providerStatus.status === "cancelled"))
          || (event.type === "payment.failed" && providerStatus.status === "succeeded");

        if (terminalContradiction) {
          return NextResponse.json(
            { ok: true, reconciliationRequired: true },
            { status: 202 },
          );
        }

        // pending/not_found/ambiguous can be eventual-consistency or provider
        // availability states. Fail closed with 5xx so ChariPay retries while
        // the independent reconciliation worker can also recover the payment.
        return NextResponse.json(
          { error: "PROVIDER_STATUS_NOT_CONFIRMED" },
          { status: 503 },
        );
      }
    }

    const refundEvidence: RefundProviderEvidence | undefined = isRefundEvent ? {
      provider: provider.name,
      amountCents: event.amountCents,
      currency: event.currency,
      paymentExternalId: event.paymentExternalId,
      providerPaymentId: event.providerPaymentId || undefined,
      providerRefundId: event.providerRefundId,
    } : undefined;

    const paymentId = payment.id;
    const result: WebhookResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;

      const newEventId = crypto.randomUUID();
      // A JS Date parameter, not raw-SQL now() — received_at is a naive
      // `timestamp` column; every other naive-timestamp write in this
      // codebase uses this same true-UTC-digits convention (see
      // TASKS.md's naive-timestamp-vs-now() writeup) rather than a
      // server-computed value subject to the session's TimeZone GUC.
      const persistedEvidence = webhookEvidence(event.raw);
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
        VALUES (${newEventId}, ${paymentId}, ${provider.name}, ${event.externalEventId}, ${event.type}, ${JSON.stringify(persistedEvidence)}::jsonb, true, ${new Date()})
        ON CONFLICT (provider, external_event_id) DO NOTHING
        RETURNING id
      `;

      let paymentEventId: string;
      if (claimed.length > 0) {
        paymentEventId = claimed[0]!.id;
      } else {
        const existing = await tx.paymentEvent.findUniqueOrThrow({
          where: { provider_externalEventId: { provider: provider.name, externalEventId: event.externalEventId } },
        });
        if (!consistentClaim(existing, paymentId, event)) {
          await tx.auditLog.create({
            data: {
              actorType: "system",
              action: "payment.webhook_event_collision",
              entityType: "PaymentEvent",
              entityId: existing.id,
              metadata: { externalEventId: event.externalEventId, incomingEventType: event.type },
            },
          });
          return { kind: "event_collision" } as const;
        }
        if (existing.processedAt !== null) return { kind: "duplicate" } as const;
        paymentEventId = existing.id;
      }

      if (isRefundEvent) {
        // Finalization intentionally happens after this claim transaction. A
        // crash leaves processedAt=null, so a provider retry re-enters the
        // idempotent finalizer rather than losing the financial event.
        return {
          kind: "processed",
          outcome: event.type,
          refundId: refund!.id,
          paymentEventId,
          providerRefundId: event.providerRefundId,
        } as const;
      }

      let outcome: string;
      if (event.type === "payment.succeeded") {
        outcome = await confirmOrderPayment(payment.orderId, tx);
        if (outcome === "paid" || outcome === "paid_but_unfulfillable" || outcome === "reconciliation_required") {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "paid" } });
        }
        // Enqueued in this same transaction, not sent after commit: a crash
        // between commit and send can no longer lose the notification — see
        // lib/email/notifications.ts and lib/email/dispatcher.ts.
        if (outcome === "paid") {
          await enqueueOrderConfirmationEmail(tx, payment.orderId);
        } else if (outcome === "paid_but_unfulfillable" || outcome === "reconciliation_required") {
          await enqueueReconciliationAlertEmail(tx, payment.orderId);
        }
      } else if (event.type === "payment.failed") {
        outcome = await failOrderPayment(payment.orderId, "failed", tx);
        if (outcome === "failed") {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
          await enqueuePaymentFailedEmail(tx, payment.orderId);
        }
      } else {
        outcome = "ignored";
      }

      await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });
      return { kind: "processed", outcome, orderId: payment.orderId } as const;
    });

    if (result.kind === "duplicate") return NextResponse.json({ ok: true, duplicate: true });
    if (result.kind === "event_collision") return NextResponse.json({ error: "EVENT_COLLISION" }, { status: 409 });

    if (result.outcome === "refund.succeeded" && result.refundId && result.paymentEventId) {
      await finalizeRefundSuccess(result.refundId, result.providerRefundId, refundEvidence);
      await prisma.paymentEvent.update({ where: { id: result.paymentEventId }, data: { processedAt: new Date() } });
    } else if (result.outcome === "refund.failed" && result.refundId && result.paymentEventId) {
      await finalizeRefundFailure(result.refundId, result.providerRefundId, refundEvidence);
      await prisma.paymentEvent.update({ where: { id: result.paymentEventId }, data: { processedAt: new Date() } });
    }

    scheduleEagerEmailDispatch();
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
