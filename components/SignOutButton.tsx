"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      className="customer-nav-signout"
      onClick={() => signOut({ callbackUrl: "/" })}
    >
      Déconnexion
    </button>
  );
}
