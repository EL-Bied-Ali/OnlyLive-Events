"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError(
          result.error === "RATE_LIMITED"
            ? "Trop de tentatives. Réessayez dans quelques minutes."
            : "Email ou mot de passe incorrect",
        );
        return;
      }
      router.push(callbackUrl);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="customer-auth-page">
      <Link href="/" className="customer-brand customer-auth-brand" aria-label="OnlyLive — accueil">
        <span className="customer-brand-mark" aria-hidden="true">OL</span>
        <span>OnlyLive</span>
      </Link>
      <section className="customer-auth-card">
        <span className="customer-summary-label">Votre compte</span>
        <h1>Se connecter</h1>
        <p className="customer-auth-intro">Accédez à vos réservations et billets OnlyLive.</p>
        <form onSubmit={handleSubmit} className="customer-auth-form">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            placeholder="vous@exemple.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <label htmlFor="login-password">Mot de passe</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            placeholder="Votre mot de passe"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {error ? <p className="customer-field-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={submitting} className="customer-primary-button customer-auth-submit">
            {submitting ? "Connexion…" : "Se connecter"}
          </button>
        </form>
        <p className="customer-auth-switch">
          Pas encore de compte ?{" "}
          <Link href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Créer un compte</Link>
        </p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
