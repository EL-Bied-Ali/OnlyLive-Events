"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_CSRF_HEADER } from "@/lib/auth/adminCsrfShared";

export function AdminLogoutButton({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/logout", {
        method: "POST",
        headers: { [ADMIN_CSRF_HEADER]: csrfToken },
      });
      if (!response.ok) return;
      router.replace("/admin/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="admin-logout" type="button" onClick={logout} disabled={busy}>
      {busy ? "Déconnexion…" : "Se déconnecter"}
    </button>
  );
}
