"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  currentPhone: string | null;
}

export function PhoneUpdateForm({ currentPhone }: Props) {
  const router = useRouter();
  const [phone, setPhone] = useState(currentPhone ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        setError(data.message ?? "Numéro de téléphone invalide.");
        return;
      }
      setEditing(false);
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
        </div>
        <button type="button" className="customer-account-edit" onClick={() => setEditing(true)}>
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
