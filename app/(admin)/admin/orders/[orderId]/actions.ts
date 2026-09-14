"use server";

import { revalidatePath } from "next/cache";
import { requireAdminRole } from "@/lib/auth/admin";
import { ApiError } from "@/lib/http/errors";
import { initiateRefund } from "@/lib/orders/refund";
import { refundMutationSchema } from "@/lib/validation/refund";
import type { AdminActionState } from "@/lib/admin/actionState";

export async function refundPaymentAction(
  _previous: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  try {
    // Refunds move money: admin/super_admin only, never support.
    const admin = await requireAdminRole(["super_admin", "admin"]);

    const parsed = refundMutationSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
      return { status: "error", message: parsed.error.issues[0]?.message ?? "Données invalides" };
    }

    const result = await initiateRefund({
      paymentId: parsed.data.paymentId,
      amountCents: parsed.data.amountCents,
      reason: parsed.data.reason,
      actorId: admin.id,
    });

    revalidatePath("/admin", "layout");
    return {
      status: "success",
      message:
        result.paymentStatus === "refunded"
          ? "Remboursement intégral effectué"
          : "Remboursement partiel effectué",
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { status: "error", message: error.message };
    }
    console.error("Refund action failed", error);
    return { status: "error", message: "Une erreur interne est survenue" };
  }
}
