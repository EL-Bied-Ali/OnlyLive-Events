"use client";

import { createContext, useContext } from "react";

const AdminCsrfContext = createContext<string | null>(null);

export function AdminCsrfProvider({ csrfToken, children }: { csrfToken: string; children: React.ReactNode }) {
  return <AdminCsrfContext.Provider value={csrfToken}>{children}</AdminCsrfContext.Provider>;
}

export function useAdminCsrfToken(): string {
  const token = useContext(AdminCsrfContext);
  if (!token) {
    throw new Error("Admin CSRF context is missing");
  }
  return token;
}
