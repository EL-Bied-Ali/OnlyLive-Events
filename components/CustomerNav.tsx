import Link from "next/link";
import { getCustomerSession } from "@/lib/auth/customer";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * Shared across every customer-facing page (marketing, auth, checkout,
 * orders, tickets, account). Reads the session read-only via
 * getCustomerSession() -- never requireCustomerForPage() here, since a
 * logged-out visitor must still see the public pages this nav sits on top
 * of, not get redirected to /login just for rendering the header.
 */
export async function CustomerNav() {
  const session = await getCustomerSession();
  const customer = session?.user;

  return (
    <header className="customer-nav">
      <Link href="/" className="customer-brand" aria-label="OnlyLive — accueil">
        <span className="customer-brand-mark" aria-hidden="true">
          OL
        </span>
        <span>OnlyLive</span>
      </Link>

      <nav className="customer-nav-links" aria-label="Navigation principale">
        <Link href="/">Événements</Link>
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
      </nav>
    </header>
  );
}
