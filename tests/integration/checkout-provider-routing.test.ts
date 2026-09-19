import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createHold } from "@/lib/inventory";
import { startCheckout } from "@/lib/orders/checkout";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

const BASE_URL = "http://localhost:3000";

async function createActiveHold(prefix: string) {
  const { category, phase } = await createTestCategory(5);
  const user = await createTestUser(prefix);
  const hold = await createHold({
    ticketCategoryId: category.id,
    salesPhaseId: phase.id,
    userId: user.id,
    quantity: 1,
  });
  return { user, reservationId: hold.reservationId };
}

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", "chari_sk_test_checkout-routing");
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "checkout-routing-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.test");
}

describe("checkout provider-specific customer requirements", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lets FakeProvider checkout succeed without a phone", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    const { user, reservationId } = await createActiveHold("fake-no-phone");
    expect(user.phone).toBeNull();

    const result = await startCheckout(reservationId, user.id, BASE_URL);
    expect(result.redirectUrl).toMatch(/^\/pay\/fake\//);
    await expect(prisma.payment.findFirstOrThrow({ where: { orderId: result.orderId } })).resolves.toMatchObject({
      provider: "fake",
      status: "awaiting_payment",
    });
  });

  it("rejects missing and invalid ChariPay phone details before network I/O", async () => {
    enableChariPay();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { user, reservationId } = await createActiveHold("chari-required-phone");

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 422,
      code: "PAYMENT_CUSTOMER_DETAILS_REQUIRED",
    });

    await prisma.user.update({ where: { id: user.id }, data: { phone: "not-a-phone" } });
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 422,
      code: "PAYMENT_CUSTOMER_DETAILS_REQUIRED",
    });

    await prisma.user.update({ where: { id: user.id }, data: { phone: "+212600000000", name: null } });
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 422,
      code: "PAYMENT_CUSTOMER_DETAILS_REQUIRED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not pass a per-session notification URL into a ChariPay session", async () => {
    enableChariPay();
    vi.stubEnv("VERCEL_ENV", "preview");
    const { user, reservationId } = await createActiveHold("chari-no-session-webhook");
    await prisma.user.update({
      where: { id: user.id },
      data: { phone: "+212600000000", name: "Preview Buyer" },
    });

    const createPaymentSpy = vi.spyOn(ChariPayProvider.prototype, "createPayment").mockResolvedValue({
      providerPaymentId: `ps_${crypto.randomUUID()}`,
      redirectUrl: "https://checkout.charipay.test/session",
    });

    await startCheckout(reservationId, user.id, BASE_URL);

    expect(createPaymentSpy).toHaveBeenCalledTimes(1);
    const input = createPaymentSpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(input.returnUrl).toMatch(/^https:\/\/preview\.onlylive\.test\/orders\//);
    expect("webhookUrl" in input).toBe(false);
  });
  it("keeps historical fake Payment initialization on FakeProvider after the default changes", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    const { user, reservationId } = await createActiveHold("historical-fake-init");
    const firstAttempt = vi.spyOn(FakeProvider.prototype, "createPayment")
      .mockRejectedValueOnce(new Error("simulated fake provider interruption"));

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 502 });
    firstAttempt.mockRestore();
    const persisted = await prisma.payment.findFirstOrThrow({ where: { order: { userId: user.id } } });
    expect(persisted.provider).toBe("fake");

    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    const fakeSpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    const chariSpy = vi.spyOn(ChariPayProvider.prototype, "createPayment");
    const result = await startCheckout(reservationId, user.id, BASE_URL);

    expect(result.redirectUrl).toMatch(/^\/pay\/fake\//);
    expect(fakeSpy).toHaveBeenCalledTimes(1);
    expect(chariSpy).not.toHaveBeenCalled();
  });
});
