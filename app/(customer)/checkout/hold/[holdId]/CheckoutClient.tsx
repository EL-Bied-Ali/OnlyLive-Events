"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { classifyCheckoutNavigation } from "@/lib/payments/redirect";

interface CheckoutClientProps {
  reservationId: string;
  expiresAt: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  categoryName: string;
  eventTitle: string;
}

export function CheckoutClient({
  reservationId,
  expiresAt,
  quantity,
  unitPriceCents,
  currency,
  categoryName,
  eventTitle,
}: CheckoutClientProps) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set only when the provider rejects checkout for a missing/invalid phone
  // (a customer who registered before phone became mandatory) — see
  // /api/customers/phone. Never shown speculatively: only after the
  // provider itself says it's needed, so this never blocks a provider
  // (like FakeProvider) that doesn't require one.
  const [needsPhone, setNeedsPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const expired = secondsLeft <= 0;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const total = ((quantity * unitPriceCents) / 100).toFixed(2);

  async function handlePay() {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/checkout/${reservationId}/start`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        if (data.error === "PAYMENT_CUSTOMER_DETAILS_REQUIRED") {
          setNeedsPhone(true);
          return;
        }
        setError(data.message ?? "Impossible de démarrer le paiement");
        return;
      }
      const navigation = classifyCheckoutNavigation(data.redirectUrl);
      if (navigation.kind === "external") {
        window.location.assign(navigation.url);
        return;
      }
      router.push(navigation.url);
    } catch {
      setError("Erreur réseau, réessayez");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSavePhone(event: React.FormEvent) {
    event.preventDefault();
    setPhoneError(null);
    setSavingPhone(true);
    try {
      const response = await fetch("/api/customers/phone", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await response.json();
      if (!response.ok) {
        setPhoneError(data.message ?? "Numéro de téléphone invalide");
        return;
      }
      setNeedsPhone(false);
      // Retry checkout immediately now that the provider's requirement is met.
      await handlePay();
    } catch {
      setPhoneError("Erreur réseau, réessayez");
    } finally {
      setSavingPhone(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 26, marginBottom: 16 }}>Finaliser la réservation</h1>
      <div style={{ border: "1px solid #333", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <p style={{ margin: "0 0 4px" }}>{eventTitle}</p>
        <p style={{ margin: "0 0 4px", opacity: 0.8 }}>
          {quantity} × {categoryName}
        </p>
        <p style={{ fontSize: 20, fontWeight: 600, margin: "12px 0 0" }}>
          {total} {currency}
        </p>
      </div>

      {!expired ? (
        <p style={{ marginBottom: 16 }}>
          Votre réservation expire dans{" "}
          <strong>
            {minutes}:{seconds.toString().padStart(2, "0")}
          </strong>
        </p>
      ) : (
        <p style={{ marginBottom: 16, color: "#ff6b6b" }}>Votre réservation a expiré.</p>
      )}

      {error && <p style={{ color: "#ff6b6b" }}>{error}</p>}

      {needsPhone ? (
        <form onSubmit={handleSavePhone} style={{ display: "grid", gap: 12 }}>
          <p style={{ margin: 0 }}>
            Un numéro de téléphone est requis pour finaliser ce paiement.
          </p>
          <input
            type="tel"
            placeholder="Téléphone (ex. 06 12 34 56 78)"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            required
            minLength={8}
            style={{ padding: 10 }}
          />
          {phoneError && <p style={{ color: "#ff6b6b", margin: 0 }}>{phoneError}</p>}
          <button type="submit" disabled={savingPhone} style={{ padding: 14, width: "100%" }}>
            {savingPhone ? "..." : "Enregistrer et continuer"}
          </button>
        </form>
      ) : (
        <button onClick={handlePay} disabled={expired || submitting} style={{ padding: 14, width: "100%" }}>
          {submitting ? "..." : "Payer"}
        </button>
      )}
    </main>
  );
}
