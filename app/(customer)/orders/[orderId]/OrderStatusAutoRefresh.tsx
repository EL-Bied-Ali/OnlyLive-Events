"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 5_000;
const MAX_REFRESHES = 60;
const DELAYED_WARNING_AFTER_MS = 45_000;

const RECONCILABLE_STATUSES = new Set(["pending_payment"]);
const REFRESH_ONLY_STATUSES = new Set(["paid_but_unfulfillable", "reconciliation_required"]);

interface Props {
  orderId: string;
  status: string;
}

/**
 * Browser redirects (and 3DS return screens) are not proof of payment. While
 * status is pending_payment, this component both refreshes the Server
 * Component (to pick up a webhook that already landed) and asks OnlyLive to
 * check ChariPay's authenticated ledger directly (POST
 * /api/orders/[orderId]/reconcile-payment), so a delayed webhook does not
 * make the customer wait longer than necessary to see a confirmed order.
 * Never calls ChariPay from the browser and never receives provider
 * credentials or raw ledger data — only the order's own status comes back.
 *
 * For paid_but_unfulfillable / reconciliation_required the payment is
 * already captured and only an admin action can move the order further, so
 * only the plain Server Component refresh runs (no ledger lookups to make).
 *
 * Polling runs every 5 seconds for at most 5 minutes and stops entirely once
 * the Server Component observes a status this component no longer covers.
 * A visible message replaces silent polling if confirmation takes unusually
 * long, and tells the customer not to submit a second payment.
 *
 * ChariPay's provider request timeout (12s) is longer than the 5s poll
 * interval. An in-flight guard keeps one browser instance from overlapping
 * its own reconciliation calls, while the server-side rate limit remains
 * abuse protection for extra tabs/clients. Cleanup aborts any in-flight
 * request when the order/status changes.
 */
export function OrderStatusAutoRefresh({ orderId, status }: Props) {
  const router = useRouter();
  const attempts = useRef(0);
  const startedAt = useRef(0);
  const [delayed, setDelayed] = useState(false);
  const [stopped, setStopped] = useState(false);

  const reconcilable = RECONCILABLE_STATUSES.has(status);
  const active = reconcilable || REFRESH_ONLY_STATUSES.has(status);

  useEffect(() => {
    if (!active) return;

    attempts.current = 0;
    startedAt.current = Date.now();
    setDelayed(false);
    setStopped(false);

    const controller = new AbortController();
    let reconcileInFlight = false;

    const tick = async () => {
      attempts.current += 1;

      if (Date.now() - startedAt.current >= DELAYED_WARNING_AFTER_MS) {
        setDelayed(true);
      }

      if (reconcilable && !reconcileInFlight) {
        reconcileInFlight = true;
        try {
          const response = await fetch(`/api/orders/${orderId}/reconcile-payment`, {
            method: "POST",
            signal: controller.signal,
          });
          if (response.ok) {
            const body = (await response.json()) as { reconciled?: boolean };
            if (body.reconciled && !controller.signal.aborted) {
              router.refresh();
              return;
            }
          }
        } catch {
          // Network hiccup, timeout, or this effect's cleanup aborting the
          // request — fail closed and keep the normal refresh schedule.
        } finally {
          reconcileInFlight = false;
        }
      }

      if (controller.signal.aborted) return;

      router.refresh();
      if (attempts.current >= MAX_REFRESHES) {
        window.clearInterval(interval);
        setStopped(true);
      }
    };

    const interval = window.setInterval(tick, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [active, reconcilable, orderId, router]);

  if (!reconcilable) return null;

  return (
    <div
      className={`customer-status-refresh${delayed || stopped ? " customer-status-refresh-delayed" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="customer-refresh-spinner" aria-hidden="true" />
      <div>
        <strong>
          {stopped
            ? "La vérification automatique est en pause."
            : delayed
              ? "La confirmation prend plus de temps que prévu."
              : "Confirmation du paiement en cours…"}
        </strong>
        <p>
          {stopped
            ? "Actualisez cette page avant toute nouvelle tentative de paiement."
            : delayed
              ? "Nous continuons à vérifier. Ne relancez pas un second paiement."
              : "Vous pouvez rester sur cette page ; elle se met à jour automatiquement."}
        </p>
      </div>
    </div>
  );
}
