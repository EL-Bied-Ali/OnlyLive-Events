import Link from "next/link";
import { requireAdminForPage } from "@/lib/auth/admin";
import { getAdminCsrfTokenForPage } from "@/lib/auth/adminCsrf";
import { AdminLogoutButton } from "./AdminLogoutButton";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminForPage();
  const csrfToken = await getAdminCsrfTokenForPage();

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link className="admin-logo" href="/admin">
          <span className="admin-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <nav aria-label="Navigation administration">
          <Link href="/admin">Vue d’ensemble</Link>
          <Link href="/admin/events">Événements</Link>
          <Link href="/admin/orders">Commandes</Link>
          <Link href="/admin/audit">Journal d’audit</Link>
          <Link href="/scanner">Scanner</Link>
        </nav>
        <div className="admin-account">
          <span>{admin.name}</span>
          <small>{admin.role.replace("_", " ")}</small>
          <AdminLogoutButton csrfToken={csrfToken} />
        </div>
      </aside>
      <div className="admin-main">{children}</div>
    </div>
  );
}
