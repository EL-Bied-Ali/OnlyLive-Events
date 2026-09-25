import type { ReactNode } from "react";
import Link from "next/link";
import { getCustomerSession } from "@/lib/auth/customer";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * Shared across every customer-facing page (marketing, orders, tickets).
 * Reads the session read-only via getCustomerSession() -- never
 * requireCustomerForPage() here, since a logged-out visitor must still see
 * the public pages this nav sits on top of, not get redirected to /login
 * just for rendering the header. `trailing` renders before the auth-aware
 * links, inside the same right-hand flex group as .live-nav (which lays
 * out exactly two children: the brand, and everything else) -- used for
 * page-specific context like the event page's "back to all events" link.
 */
export async function CustomerNav({ trailing }: { trailing?: ReactNode } = {}) {
  const session = await getCustomerSession();
  const customer = session?.user;

  return (
    <nav className="live-nav" aria-label="Navigation principale">
      <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
        <span className="live-brand-mark" aria-hidden="true">
          OL
        </span>
        <span>OnlyLive</span>
      </Link>

      <div className="customer-nav-links">
        {trailing}
        {customer ? (
          <>
            <Link href="/mes-billets">Mes billets</Link>
            {/* Mes commandes / Compte land once those pages ship -- no
                dead links in the meantime. */}
            <SignOutButton />
          </>
        ) : (
          <>
            <Link href="/login" className="customer-nav-login">
              Connexion
            </Link>
            <Link href="/register" className="customer-nav-register">
              Inscription
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
