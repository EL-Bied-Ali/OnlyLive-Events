"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  currentPhone: string | null;
}

// Keyed by the API's `error` code, never its `message` -- that field can be
// an internal/English string (a hardcoded rate-limit message, a raw Zod
// validation message, a generic 500 fallback) never meant for direct
// customer display. Unknown codes fall back to the generic message below,
// same as before this map existed.
const PHONE_UPDATE_ERROR_MESSAGES: Record<string, string> = {
  RATE_LIMITED: "Trop de tentatives. Réessayez dans quelques minutes.",
  INVALID_INPUT: "Numéro de téléphone invalide.",
  UNAUTHENTICATED: "Votre session a expiré. Reconnectez-vous puis réessayez.",
};

export function PhoneUpdateForm({ currentPhone }: Props) {
  const router = useRouter();
  const [phone, setPhone] = useState(currentPhone ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  function startEditing() {
    setJustSaved(false);
    setEditing(true);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const response = await fetch("/api/customers/phone", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(PHONE_UPDATE_ERROR_MESSAGES[data.error] ?? "Numéro de téléphone invalide.");
        return;
      }
      setEditing(false);
      setJustSaved(true);
      router.refresh();
    } catch {
      setError("Impossible d’enregistrer le numéro pour le moment. Vérifiez votre connexion puis réessayez.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="customer-account-field">
        <div>
          <span className="customer-summary-label">Téléphone</span>
          <strong>{currentPhone ?? "Non renseigné"}</strong>
          {justSaved && (
            <p role="status" aria-live="polite" className="customer-account-success">
              Numéro mis à jour.
            </p>
          )}
        </div>
        <button type="button" className="customer-account-edit" onClick={startEditing}>
          Modifier
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="customer-account-field customer-account-field-editing">
      <div>
        <label htmlFor="account-phone" className="customer-summary-label">
          Téléphone
        </label>
        <input
          id="account-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
          minLength={8}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "account-phone-error" : undefined}
        />
        {error && (
          <p id="account-phone-error" className="customer-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="customer-account-field-actions">
        <button type="submit" disabled={saving} className="customer-account-save">
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button
          type="button"
          className="customer-account-cancel"
          disabled={saving}
          onClick={() => {
            setPhone(currentPhone ?? "");
            setError(null);
            setEditing(false);
          }}
        >
          Annuler
        </button>
      </div>
    </form>
  );
}
