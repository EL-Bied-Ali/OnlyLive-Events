import { notFound } from "next/navigation";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { prisma } from "@/lib/db";
import { CustomerNav } from "@/components/CustomerNav";
import { SignOutButton } from "@/components/SignOutButton";
import { PhoneUpdateForm } from "./PhoneUpdateForm";

export const dynamic = "force-dynamic";

export default async function MonComptePage() {
  const customer = await requireCustomerForPage("/mon-compte");

  // The JWT session carries name/email as of sign-in time, not necessarily
  // current -- read the live row rather than trust a potentially stale token.
  const user = await prisma.user.findUnique({
    where: { id: customer.id },
    select: { name: true, email: true, phone: true },
  });

  if (!user) notFound();

  return (
    <main className="customer-account-page">
      <CustomerNav />

      <div className="customer-account-heading">
        <h1>Mon compte</h1>
        <p>Vos informations personnelles OnlyLive.</p>
      </div>

      <section className="customer-account-card" aria-label="Informations personnelles">
        <div className="customer-account-field">
          <div>
            <span className="customer-summary-label">Nom</span>
            <strong>{user.name ?? "Non renseigné"}</strong>
          </div>
        </div>

        <div className="customer-account-field">
          <div>
            <span className="customer-summary-label">Email</span>
            <strong>{user.email}</strong>
          </div>
        </div>

        <PhoneUpdateForm currentPhone={user.phone} />
      </section>

      <div className="customer-account-signout">
        <SignOutButton />
      </div>
    </main>
  );
}
