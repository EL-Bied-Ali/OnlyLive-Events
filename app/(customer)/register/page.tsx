"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
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
    <main style={{ maxWidth: 400, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 24 }}>Créer un compte</h1>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        <input
          placeholder="Nom"
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          required
          style={{ padding: 10 }}
        />
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
          required
          style={{ padding: 10 }}
        />
        <input
          type="password"
          placeholder="Mot de passe (10 caractères min.)"
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          required
          minLength={10}
          style={{ padding: 10 }}
        />
        {error && <p style={{ color: "#ff6b6b", margin: 0 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: 12 }}>
          {submitting ? "..." : "Créer mon compte"}
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        Déjà un compte ? <Link href="/login">Se connecter</Link>
      </p>
    </main>
  );
}
