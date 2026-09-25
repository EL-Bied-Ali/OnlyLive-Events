"use client";

import { useState, type ReactNode } from "react";

/**
 * Wraps CustomerNav's auth-aware links. On desktop this renders as an
 * invisible wrapper (globals.css forces the panel open and hides the
 * toggle above the mobile breakpoint, regardless of `open` state below --
 * see ".customer-nav-menu-panel" / ".customer-nav-menu-toggle"). On mobile
 * it collapses that link list behind a single button instead of letting
 * five-plus links wrap across several rows and push the header past
 * 200px tall (Mes billets + Mes commandes + Compte + Aide + Déconnexion,
 * on top of any page-specific `trailing` content CustomerNav renders
 * outside this component, unaffected by the toggle).
 */
export function CustomerNavMobileMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="customer-nav-menu">
      <button
        type="button"
        className="customer-nav-menu-toggle"
        aria-expanded={open}
        aria-controls="customer-nav-menu-panel"
        onClick={() => setOpen((value) => !value)}
      >
        Menu
        <span aria-hidden="true" className={`customer-nav-menu-icon${open ? " is-open" : ""}`} />
      </button>
      <div id="customer-nav-menu-panel" className="customer-nav-menu-panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
