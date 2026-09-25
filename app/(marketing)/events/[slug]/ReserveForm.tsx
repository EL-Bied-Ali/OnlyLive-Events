"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

interface ReserveFormProps {
  ticketCategoryId: string;
  salesPhaseId: string;
  available: number;
  maxPerOrder: number;
}

export function ReserveForm({ ticketCategoryId, salesPhaseId, available, maxPerOrder }: ReserveFormProps) {
  const router = useRouter();
  const { status } = useSession();
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (available <= 0) {
    return <p className="live-ticket-unavailable">Épuisé</p>;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (status === "loading") {
      return;
    }
    if (status === "unauthenticated") {
      router.push(`/login?callbackUrl=${encodeURIComponent(window.location.pathname)}`);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/holds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketCategoryId, salesPhaseId, quantity }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Impossible de réserver ces billets");
        return;
      }
      router.push(`/checkout/hold/${data.reservationId}`);
    } catch {
      setError("Erreur réseau, réessayez");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="live-reserve-form">
      <label htmlFor={`quantity-${ticketCategoryId}`}>Quantité</label>
      <select
        id={`quantity-${ticketCategoryId}`}
        value={quantity}
        onChange={(event) => setQuantity(Number(event.target.value))}
        disabled={submitting}
      >
        {Array.from({ length: Math.min(maxPerOrder, available) }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <button type="submit" disabled={submitting || status === "loading"}>
        {submitting ? "Réservation…" : status === "loading" ? "Vérification…" : "Réserver"}<span aria-hidden="true">→</span>
      </button>
      {error ? <span className="live-reserve-error" role="alert">{error}</span> : null}
    </form>
  );
}
