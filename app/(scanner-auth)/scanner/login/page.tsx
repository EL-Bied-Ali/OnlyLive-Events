import type { Metadata } from "next";
import { ScannerLoginForm } from "./ScannerLoginForm";

export const metadata: Metadata = { title: "Scanner · OnlyLive" };

export default function ScannerLoginPage() {
  return (
    <main className="scanner-login-page">
      <section className="scanner-login-card">
        <div className="admin-brand-mark" aria-hidden="true">OL</div>
        <p className="admin-eyebrow">Contrôle d’accès</p>
        <h1>OnlyLive Scanner</h1>
        <p>Connectez-vous avec votre compte équipe.</p>
        <ScannerLoginForm />
      </section>
    </main>
  );
}
