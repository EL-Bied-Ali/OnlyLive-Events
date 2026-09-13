import type { Metadata } from "next";
import { AdminLoginForm } from "./AdminLoginForm";

export const metadata: Metadata = { title: "Administration · OnlyLive" };

export default function AdminLoginPage() {
  return (
    <main className="admin-login-page">
      <section className="admin-login-card">
        <div className="admin-brand-mark" aria-hidden="true">OL</div>
        <p className="admin-eyebrow">OnlyLive Events</p>
        <h1>Espace administration</h1>
        <p className="admin-muted">Accès réservé à l’équipe OnlyLive.</p>
        <AdminLoginForm />
      </section>
    </main>
  );
}
