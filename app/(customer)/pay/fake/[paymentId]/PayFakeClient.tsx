"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PayFakeClient({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<"succeeded" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function simulate(outcome: "succeeded" | "failed") {
    setError(null);
    setSubmitting(outcome);
    try {
      const response = await fetch(`/api/pay/fake/${paymentId}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Erreur de simulation");
        return;
      }
      router.push(`/orders/${data.orderId}`);
    } catch {
      setError("Erreur réseau, réessayez");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="fake-payment-actions">
      {error && <p className="customer-auth-error" role="alert">{error}</p>}
      <button className="fake-payment-success" onClick={() => simulate("succeeded")} disabled={submitting !== null}>
        {submitting === "succeeded" ? "Confirmation…" : "Simuler un paiement réussi"}
      </button>
      <button className="fake-payment-failure" onClick={() => simulate("failed")} disabled={submitting !== null}>
        {submitting === "failed" ? "Confirmation…" : "Simuler un paiement échoué"}
      </button>
    </div>
  );
}
