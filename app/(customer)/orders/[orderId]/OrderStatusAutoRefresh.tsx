"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 5_000;
const MAX_REFRESHES = 60;
/**
 * After this much unresolved polling, swap the calm "confirmation en cours"
 * copy for an explicit "this is taking longer than expected" warning so the
 * customer knows not to re-attempt payment, rather than staying silent.
 */
const DELAYED_WARNING_AFTER_MS = 45_000;

const RECONCILABLE_STATUSES = new Set(["pending_payment"]);
const REFRESH_ONLY_STATUSES = new Set(["paid_but_unfulfillable", "reconciliation_required"]);

interface Props {
  orderId: string;
  status: string;
}

/**
 * Browser redirects (and 3DS return screens) are not proof of payment. While
 * `status` is `pending_payment`, this component both refreshes the Server
 * Component (to pick up a webhook that already landed) and asks OnlyLive to
 * check ChariPay's authenticated ledger directly (POST
 * /api/orders/[orderId]/reconcile-payment), so a delayed webhook does not
 * make the customer wait longer than necessary to see "Payée". Never calls
 * ChariPay from the browser and never receives provider credentials or raw
 * ledger data — only the order's own status comes back.
 *
 * For `paid_but_unfulfillable` / `reconciliation_required` the payment is
 * already captured and only an admin action can move the order further, so
 * only the plain Server Component refresh runs (no ledger lookups to make).
 *
 * Runs for at most one minute-ish of polling, and unmounts/stops entirely
 * the moment a refresh observes a status this component no longer covers —
 * `status` flows down from the Server Component's live DB read, so once the
 * order becomes `paid` (or any other terminal state) the next render simply
 * omits this component.
 */
export function OrderStatusAutoRefresh({ orderId, status }: Props) {
  const router = useRouter();
  const attempts = useRef(0);
  const startedAt = useRef(0);
  const [delayed, setDelayed] = useState(false);

  const reconcilable = RECONCILABLE_STATUSES.has(status);
  const active = reconcilable || REFRESH_ONLY_STATUSES.has(status);

  useEffect(() => {
    if (!active) return;
    attempts.current = 0;
    startedAt.current = Date.now();

    const tick = async () => {
      attempts.current += 1;
      if (Date.now() - startedAt.current >= DELAYED_WARNING_AFTER_MS) {
        setDelayed(true);
      }

      if (reconcilable) {
        try {
          const response = await fetch(`/api/orders/${orderId}/reconcile-payment`, { method: "POST" });
          if (response.ok) {
            const body = (await response.json()) as { reconciled?: boolean };
            if (body.reconciled) {
              router.refresh();
              return;
            }
          }
        } catch {
          // Network hiccup on a polling request — fail closed and keep
          // polling on the normal schedule rather than surfacing an error.
        }
      }

      router.refresh();
      if (attempts.current >= MAX_REFRESHES) window.clearInterval(interval);
    };

    const interval = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, reconcilable, orderId, router]);

  if (!reconcilable) return null;

  return (
    <p style={{ margin: "0 0 24px", opacity: 0.85 }}>
      {delayed
        ? "La vérification du paiement prend plus de temps que prévu. Ne relancez pas le paiement."
        : "Paiement effectué — confirmation en cours."}
    </p>
  );
}
