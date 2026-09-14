"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 2_000;
const MAX_REFRESHES = 30;

/**
 * Browser redirects are not proof of payment. While a ChariPay webhook (or
 * reconciliation) is still expected, refresh the Server Component for at most
 * one minute so the customer sees the authoritative DB state without being
 * trapped in an infinite polling loop.
 */
export function OrderStatusAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const attempts = useRef(0);

  useEffect(() => {
    if (!active) return;
    attempts.current = 0;
    const interval = window.setInterval(() => {
      attempts.current += 1;
      router.refresh();
      if (attempts.current >= MAX_REFRESHES) window.clearInterval(interval);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, router]);

  return null;
}
