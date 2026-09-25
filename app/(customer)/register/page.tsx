"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/customers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Impossible de créer le compte");
        return;
      }

      const result = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });
      if (result?.error) {
        setError("Compte créé. Connectez-vous pour continuer.");
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
      <Link href="/" className="live-brand customer-auth-brand" aria-label="OnlyLive — accueil">
        <span className="live-brand-mark" aria-hidden="true">OL</span>
        <span>OnlyLive</span>
      </Link>
      <section className="customer-auth-card">
        <p className="live-kicker"><span aria-hidden="true" /> Première fois ici</p>
        <h1>Votre prochaine soirée commence ici.</h1>
        <p className="customer-auth-intro">Créez votre compte pour réserver et retrouver vos billets OnlyLive.</p>
        <form onSubmit={handleSubmit} className="customer-auth-form">
          <label htmlFor="register-name">Nom</label>
          <input
            id="register-name"
            autoComplete="name"
            placeholder="Votre nom"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />

          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            type="email"
            autoComplete="email"
            placeholder="vous@exemple.com"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            required
          />

          <label htmlFor="register-password">Mot de passe</label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            placeholder="10 caractères minimum"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            required
            minLength={10}
          />

          <label htmlFor="register-phone">Téléphone</label>
          <input
            id="register-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Ex. 06 12 34 56 78"
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
            required
            minLength={8}
          />

          {error ? <p className="customer-auth-error" role="alert">{error}</p> : null}

          <button type="submit" disabled={submitting}>
            {submitting ? "Création…" : "Créer mon compte"}
          </button>
        </form>
        <p className="customer-auth-switch">
          Déjà un compte ?{" "}
          <Link href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Se connecter</Link>
        </p>
      </section>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
