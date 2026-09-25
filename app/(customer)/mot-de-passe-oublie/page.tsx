"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Deliberately a single generic state, success or "account not found" or
  // rate-limited all land here with the exact same neutral message -- see
  // app/api/auth/forgot-password/route.ts's own comment on why.
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      setSubmitting(false);
      setDone(true);
    }
  }

  return (
    <main className="customer-auth-page">
      <Link href="/" className="live-brand customer-auth-brand" aria-label="OnlyLive — accueil">
        <span className="live-brand-mark" aria-hidden="true">
          OL
        </span>
        <span>OnlyLive</span>
      </Link>
      <section className="customer-auth-card">
        <p className="live-kicker">
          <span aria-hidden="true" /> Espace client
        </p>
        <h1>Mot de passe oublié</h1>
        <p className="customer-auth-intro">
          Indiquez votre email : si un compte existe, vous recevrez un lien pour choisir un nouveau mot de passe.
        </p>

        {done ? (
          <p className="customer-auth-intro" role="status">
            Si un compte existe avec cette adresse, un email de réinitialisation vient d’être envoyé. Pensez à
            vérifier vos courriers indésirables.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="customer-auth-form">
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              placeholder="vous@exemple.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <button type="submit" disabled={submitting}>
              {submitting ? "Envoi…" : "Envoyer le lien"}
            </button>
          </form>
        )}

        <p className="customer-auth-switch">
          <Link href="/login">Retour à la connexion</Link>
        </p>
      </section>
    </main>
  );
}
