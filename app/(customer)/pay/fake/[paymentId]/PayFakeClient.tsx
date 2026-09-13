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
    <div style={{ display: "grid", gap: 12 }}>
      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}
      <button onClick={() => simulate("succeeded")} disabled={submitting !== null} style={{ padding: 14 }}>
        {submitting === "succeeded" ? "..." : "Simuler un paiement réussi"}
      </button>
      <button onClick={() => simulate("failed")} disabled={submitting !== null} style={{ padding: 14 }}>
        {submitting === "failed" ? "..." : "Simuler un paiement échoué"}
      </button>
    </div>
  );
}
