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
      <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
        <span className="live-brand-mark" aria-hidden="true">OL</span><span>OnlyLive</span>
      </Link>
      <section className="customer-auth-card">
      <p className="live-kicker"><span aria-hidden="true" /> Espace client</p>
      <h1>Retrouvez votre soirée.</h1>
      <p className="customer-auth-intro">Connectez-vous pour réserver vos billets et retrouver vos commandes.</p>
      <form onSubmit={handleSubmit} className="customer-auth-form">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          aria-label="Email"
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          aria-label="Mot de passe"
        />
        {error && <p className="customer-auth-error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Connexion…" : "Se connecter"}
        </button>
      </form>
      <p className="customer-auth-switch">
        Pas encore de compte ? <Link href="/register">Créer un compte</Link>
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
