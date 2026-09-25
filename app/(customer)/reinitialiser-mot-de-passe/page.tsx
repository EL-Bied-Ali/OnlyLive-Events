"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function ResetPasswordForm() {
  const router = useRouter();
  // The token travels in the URL fragment (#token=...), never a query
  // string: a fragment is never sent to the server, so it can't land in
  // Vercel/access logs or get captured by browser history the way a query
  // param would. Read on mount only -- window is unavailable during SSR --
  // and immediately scrub it from the visible URL so it doesn't linger
  // there either (e.g. if the user copies the URL after it loads).
  const [token, setToken] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    const extracted = hash.startsWith("#") ? new URLSearchParams(hash.slice(1)).get("token") : null;
    if (hash) {
      // Scrub first: once this fires, re-reading window.location.hash would
      // return empty, so the token must be captured into state from the
      // value read above, not derived again on a later render.
      window.history.replaceState(null, "", window.location.pathname);
    }
    // The token lives only in a URL fragment, which (unlike a query string)
    // Next.js cannot see server-side at all; bridging it into React state
    // on mount is the one place this value can first become available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(extracted);
    setTokenReady(true);
  }, []);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message ?? "Ce lien de réinitialisation est invalide ou a expiré.");
        return;
      }
      setDone(true);
    } catch {
      setError("Une erreur réseau est survenue. Réessayez.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!tokenReady) {
    return null;
  }

  if (!token) {
    return (
      <p className="customer-auth-error" role="alert">
        Ce lien de réinitialisation est invalide ou a expiré.{" "}
        <Link href="/mot-de-passe-oublie">Demander un nouveau lien</Link>.
      </p>
    );
  }

  if (done) {
    return (
      <>
        <p className="customer-auth-intro" role="status">
          Votre mot de passe a été mis à jour.
        </p>
        <button type="button" onClick={() => router.push("/login")}>
          Se connecter
        </button>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="customer-auth-form">
      <label htmlFor="reset-password">Nouveau mot de passe</label>
      <input
        id="reset-password"
        type="password"
        autoComplete="new-password"
        minLength={10}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      <label htmlFor="reset-password-confirm">Confirmer le mot de passe</label>
      <input
        id="reset-password-confirm"
        type="password"
        autoComplete="new-password"
        minLength={10}
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        required
      />
      {error ? (
        <p className="customer-auth-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "Enregistrement…" : "Choisir ce mot de passe"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
        <h1>Choisir un nouveau mot de passe</h1>
        <ResetPasswordForm />
      </section>
    </main>
  );
}
