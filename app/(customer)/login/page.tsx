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
    <main style={{ maxWidth: 400, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 24 }}>Se connecter</h1>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 12 }}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          style={{ padding: 10 }}
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          style={{ padding: 10 }}
        />
        {error && <p style={{ color: "#ff6b6b", margin: 0 }}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ padding: 12 }}>
          {submitting ? "..." : "Se connecter"}
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        Pas encore de compte ? <Link href="/register">Créer un compte</Link>
      </p>
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
