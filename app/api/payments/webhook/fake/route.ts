import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

/**
 * The fake provider's simulated webhook callback. Deliberately exercises
 * the exact verification path a real PSP integration will reuse:
 * signature check -> idempotent PaymentEvent insert -> order-row-locked
 * state transition -> ticket generation. See docs/PAYMENTS.md.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const provider = getPaymentProvider();
    const event = await provider.parseWebhook({ rawBody, headers });

    const payment = await prisma.payment.findUnique({
      where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: event.providerPaymentId } },
    });
    if (!payment) {
      return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
    }

    // Idempotency + replay-resistance: this INSERT is the single source
    // of truth for "have we already processed this exact event". No row
    // returned means it's a duplicate delivery — short-circuit to 200
    // without touching order/payment state again, regardless of how many
    // times the provider retries.
    const eventId = crypto.randomUUID();
    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES (${eventId}, ${payment.id}, ${provider.name}, ${event.externalEventId}, ${event.type}, ${JSON.stringify(event.raw)}::jsonb, ${event.signatureValid}, now())
      ON CONFLICT (provider, external_event_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    if (!event.signatureValid) {
      return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    }

    let outcome: string;
    switch (event.type) {
      case "payment.succeeded":
        outcome = await confirmOrderPayment(payment.orderId);
        await prisma.payment.update({ where: { id: payment.id }, data: { status: "paid" } });
        break;
      case "payment.failed":
        outcome = await failOrderPayment(payment.orderId, "failed");
        await prisma.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
        break;
      case "payment.cancelled":
        outcome = await failOrderPayment(payment.orderId, "cancelled");
        await prisma.payment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
        break;
      default:
        // refund.succeeded etc. — schema exists (Refund model) but the
        // refund flow itself is out of this session's scope.
        outcome = "ignored";
    }

    await prisma.paymentEvent.update({
      where: { id: inserted[0]!.id },
      data: { processedAt: new Date() },
    });

    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
