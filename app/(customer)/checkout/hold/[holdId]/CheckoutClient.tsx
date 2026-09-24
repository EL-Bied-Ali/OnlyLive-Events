"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { classifyCheckoutNavigation } from "@/lib/payments/redirect";

interface CheckoutClientProps {
  reservationId: string;
  reservationStatus: string;
  orderId: string | null;
  expiresAt: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  categoryName: string;
  eventTitle: string;
  eventSlug: string;
  paymentProviderName: string;
}

type CheckoutErrorPayload = {
  error?: string;
  message?: string;
};

function checkoutErrorMessage(payload: CheckoutErrorPayload): string {
  switch (payload.error) {
    case "HOLD_EXPIRED":
      return "Cette réservation a expiré. Revenez à l’événement pour sélectionner de nouveaux billets.";
    case "CHECKOUT_TOO_CLOSE_TO_EXPIRY":
      return "Il ne reste plus assez de temps pour ouvrir le paiement en toute sécurité. Recommencez la réservation.";
    case "CHECKOUT_RECONCILIATION_REQUIRED":
      return "Une tentative de paiement existe déjà pour cette réservation et doit d’abord être vérifiée. Ne relancez pas un second paiement.";
    case "PROVIDER_INITIALIZATION_IN_PROGRESS":
      return "Le paiement est encore en cours de préparation. Patientez quelques secondes puis réessayez.";
    case "PROVIDER_UNAVAILABLE":
      return "Le paiement n’a pas pu être démarré. Vérifiez l’état de votre réservation ci-dessous avant de réessayer.";
    case "ORDER_NOT_PAYABLE":
      return "Cette commande n’est plus payable. Consultez son statut avant toute nouvelle tentative.";
    default:
      return payload.message ?? "Impossible de démarrer le paiement. Réessayez dans quelques instants.";
  }
}

export function CheckoutClient({
  reservationId,
  reservationStatus,
  orderId,
  expiresAt,
  quantity,
  unitPriceCents,
  currency,
  categoryName,
  eventTitle,
  eventSlug,
  paymentProviderName,
}: CheckoutClientProps) {
  const router = useRouter();
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

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

  const expiredByTime = secondsLeft <= 0;
  const checkoutUnavailable = reservationStatus !== "active" || expiredByTime;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const total = ((quantity * unitPriceCents) / 100).toFixed(2);
  const paymentBusy = submitting || redirecting || savingPhone;
  const isChariPay = paymentProviderName === "charipay";
  const paymentDestination = isChariPay ? "ChariPay" : "le paiement sécurisé";

  async function handlePay() {
    setError(null);
    setSubmitting(true);
    let navigationStarted = false;

    try {
      const response = await fetch(`/api/checkout/${reservationId}/start`, { method: "POST" });
      const data = (await response.json()) as CheckoutErrorPayload & { redirectUrl?: string };

      if (!response.ok) {
        if (data.error === "PAYMENT_CUSTOMER_DETAILS_REQUIRED") {
          setNeedsPhone(true);
          // startCheckout may already have extended the reservation before the
          // provider rejected incomplete customer details. Refresh the Server
          // Component so the visible countdown uses the authoritative expiry.
          router.refresh();
          return;
        }
        setError(checkoutErrorMessage(data));
        // The server may have created/extended the pending checkout before a
        // provider-side failure. Keep the countdown in sync with that state.
        router.refresh();
        return;
      }

      if (!data.redirectUrl) {
        setError("Le service de paiement n’a pas renvoyé de destination valide. Réessayez.");
        router.refresh();
        return;
      }

      const navigation = classifyCheckoutNavigation(data.redirectUrl);
      navigationStarted = true;
      setRedirecting(true);

      if (navigation.kind === "external") {
        window.location.assign(navigation.url);
        return;
      }
      router.push(navigation.url);
    } catch {
      setError("La connexion au service de paiement a échoué. Vérifiez votre réseau puis réessayez.");
    } finally {
      if (!navigationStarted) setSubmitting(false);
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
      const data = (await response.json()) as CheckoutErrorPayload;
      if (!response.ok) {
        setPhoneError(data.message ?? "Vérifiez le numéro saisi et réessayez.");
        return;
      }

      setNeedsPhone(false);
      await handlePay();
    } catch {
      setPhoneError("Impossible d’enregistrer le numéro pour le moment. Vérifiez votre connexion puis réessayez.");
    } finally {
      setSavingPhone(false);
    }
  }

  return (
    <main className="customer-checkout-page">
      <header className="customer-checkout-header">
        <Link href="/" className="customer-brand" aria-label="OnlyLive — accueil">
          <span className="customer-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <span className="customer-secure-label">{isChariPay ? "Paiement sécurisé via ChariPay" : "Paiement sécurisé"}</span>
      </header>

      <section className="customer-checkout-card" aria-labelledby="checkout-title">
        <div className="customer-checkout-step">Étape 2 sur 3 · Paiement</div>
        <h1 id="checkout-title">Finaliser votre réservation</h1>
        <p className="customer-checkout-intro">
          {isChariPay
            ? "Vérifiez votre commande avant de continuer vers ChariPay, notre prestataire de paiement."
            : "Vérifiez votre commande avant de continuer vers la page de paiement sécurisée."}
        </p>

        <div className="customer-order-summary">
          <div>
            <span className="customer-summary-label">Événement</span>
            <strong>{eventTitle}</strong>
          </div>
          <div>
            <span className="customer-summary-label">Billets</span>
            <strong>{quantity} × {categoryName}</strong>
          </div>
          <div className="customer-summary-total">
            <span>Total à payer</span>
            <strong>{total} {currency}</strong>
          </div>
        </div>

        {!checkoutUnavailable ? (
          <div className="customer-hold-notice" role="status" aria-live="polite">
            <span className="customer-hold-dot" aria-hidden="true" />
            <div>
              <strong>
                Billets réservés encore {minutes}:{seconds.toString().padStart(2, "0")}
              </strong>
              <p>Terminez le paiement avant la fin du délai pour conserver cette réservation.</p>
            </div>
          </div>
        ) : (
          <div className="customer-payment-alert customer-payment-alert-error" role="alert">
            <strong>
              {reservationStatus !== "active"
                ? "Cette réservation n’est plus active."
                : "Le délai de cette réservation est terminé."}
            </strong>
            <p>
              {orderId
                ? "Une commande existe déjà pour cette réservation. Consultez son statut avant toute nouvelle tentative de paiement."
                : "Les billets ne sont plus bloqués pour cette réservation."}
            </p>
            {orderId ? (
              <Link href={`/orders/${orderId}`}>Voir le statut de la commande</Link>
            ) : (
              <Link href={`/events/${eventSlug}`}>Retour à l’événement</Link>
            )}
          </div>
        )}

        {!checkoutUnavailable && (
          <div className="customer-payment-explainer">
            <div className="customer-payment-lock" aria-hidden="true">✓</div>
            <div>
              <strong>Ce qui va se passer</strong>
              <p>
                {isChariPay
                  ? "Vous allez être redirigé vers le checkout hébergé de ChariPay. OnlyLive ne reçoit ni ne stocke les données de votre carte. Après le paiement, vous revenez automatiquement sur OnlyLive pendant que nous confirmons le statut."
                  : "Vous allez continuer vers la page de paiement sécurisée. Après le paiement, vous revenez automatiquement sur OnlyLive pendant que nous confirmons le statut."}
              </p>
              <p className="customer-payment-warning">
                Si la confirmation prend quelques secondes, ne relancez pas un second paiement.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="customer-payment-alert customer-payment-alert-error" role="alert">
            <strong>Paiement non démarré</strong>
            <p>{error}</p>
          </div>
        )}

        {needsPhone && !checkoutUnavailable ? (
          <form onSubmit={handleSavePhone} className="customer-phone-form">
            <div>
              <h2>Votre numéro de téléphone</h2>
              <p>
                Notre partenaire de paiement en a besoin pour traiter la transaction. Il sera aussi
                enregistré sur votre compte OnlyLive pour éviter de vous le redemander.
              </p>
            </div>
            <label htmlFor="checkout-phone">Téléphone</label>
            <input
              id="checkout-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="Ex. 06 12 34 56 78"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              minLength={8}
              aria-invalid={Boolean(phoneError)}
              aria-describedby={phoneError ? "checkout-phone-error" : undefined}
            />
            {phoneError && (
              <p id="checkout-phone-error" className="customer-field-error" role="alert">
                {phoneError}
              </p>
            )}
            <button type="submit" disabled={paymentBusy} className="customer-primary-button">
              {savingPhone ? "Enregistrement…" : "Enregistrer et continuer"}
            </button>
          </form>
        ) : !checkoutUnavailable ? (
          <button onClick={handlePay} disabled={paymentBusy} className="customer-primary-button">
            {redirecting
              ? "Redirection vers le paiement…"
              : submitting
                ? "Préparation du paiement…"
                : `Continuer vers ${paymentDestination} · ${total} ${currency}`}
          </button>
        ) : null}

        {!checkoutUnavailable && (
          <p className="customer-payment-footnote">
            Les billets sont émis uniquement après confirmation du paiement par le prestataire.
          </p>
        )}
      </section>
    </main>
  );
}
