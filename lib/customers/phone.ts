import { prisma } from "@/lib/db";

/**
 * Lets an already-authenticated customer add or correct their phone number
 * post-registration. Needed for accounts created before phone became
 * required at registration (PR #18) — those rows have `phone: null` and
 * would otherwise only discover the problem when ChariPay's adapter rejects
 * checkout with PAYMENT_CUSTOMER_DETAILS_REQUIRED.
 *
 * The update and its audit record commit atomically: an audit-write failure
 * must never leave the phone changed with no record of who changed it (the
 * two calls were originally sequential — an independent audit caught that
 * a failed audit insert would return a 500 while the phone had already
 * silently changed).
 */
export async function updateCustomerPhone(userId: string, phone: string): Promise<{ id: string; phone: string }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { phone },
      select: { id: true, phone: true },
    });

    await tx.auditLog.create({
      data: {
        actorType: "customer",
        actorId: user.id,
        action: "customer.phone_updated",
        entityType: "User",
        entityId: user.id,
      },
    });

    return { id: user.id, phone: user.phone! };
  });
}
