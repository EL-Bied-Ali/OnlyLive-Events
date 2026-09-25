"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
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

      await signIn("credentials", { email: form.email, password: form.password, redirect: false });
      router.push("/");
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
      <p className="live-kicker"><span aria-hidden="true" /> Première fois ici</p>
      <h1>Votre prochaine soirée commence ici.</h1>
      <p className="customer-auth-intro">Créez votre compte pour réserver et recevoir vos billets officiels.</p>
      <form onSubmit={handleSubmit} className="customer-auth-form">
        <input
          placeholder="Nom"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          required
          aria-label="Nom"
        />
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          required
          aria-label="Email"
        />
        <input
          type="password"
          placeholder="Mot de passe (10 caractères min.)"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          required
          minLength={10}
          aria-label="Mot de passe"
        />
        <input
          type="tel"
          placeholder="Téléphone (ex. 06 12 34 56 78)"
          value={form.phone}
          onChange={(event) => setForm({ ...form, phone: event.target.value })}
          required
          minLength={8}
          aria-label="Téléphone"
        />
        {error && <p className="customer-auth-error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Création…" : "Créer mon compte"}
        </button>
      </form>
      <p className="customer-auth-switch">
        Déjà un compte ? <Link href="/login">Se connecter</Link>
      </p>
      </section>
    </main>
  );
}
