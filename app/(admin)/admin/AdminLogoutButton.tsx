"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminLogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/admin/logout", { method: "POST" });
    router.replace("/admin/login");
    router.refresh();
  }

  return (
    <button className="admin-logout" type="button" onClick={logout} disabled={busy}>
      {busy ? "Déconnexion…" : "Se déconnecter"}
    </button>
  );
}
