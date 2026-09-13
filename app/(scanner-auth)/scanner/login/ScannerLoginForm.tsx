"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SCANNER_ROLES = new Set(["super_admin", "admin", "scanner"]);

export function ScannerLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (!response.ok) {
        setError("Email ou mot de passe incorrect.");
        return;
      }

      const data = (await response.json()) as { admin?: { role?: string } };
      if (!data.admin?.role || !SCANNER_ROLES.has(data.admin.role)) {
        await fetch("/api/admin/logout", { method: "POST" });
        setError("Ce compte n’est pas autorisé à contrôler les billets.");
        return;
      }

      router.replace("/scanner");
      router.refresh();
    } catch {
      setError("Connexion impossible. Vérifiez votre réseau.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="scanner-login-form" onSubmit={handleSubmit}>
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Mot de passe
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p className="scanner-error" role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Connexion…" : "Ouvrir le scanner"}
      </button>
    </form>
  );
}
