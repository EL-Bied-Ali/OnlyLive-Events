"use client";

import { useActionState } from "react";
import {
  INITIAL_ADMIN_ACTION_STATE,
  type AdminActionState,
} from "@/lib/admin/actionState";
import { ADMIN_CSRF_FORM_FIELD } from "@/lib/auth/adminCsrfShared";

interface AdminMutationFormProps {
  action: (state: AdminActionState, formData: FormData) => Promise<AdminActionState>;
  csrfToken: string;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
}

export function AdminMutationForm({
  action,
  csrfToken,
  children,
  submitLabel,
  className = "admin-edit-form",
}: AdminMutationFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ADMIN_ACTION_STATE);

  return (
    <form action={formAction} className={className}>
      <input type="hidden" name={ADMIN_CSRF_FORM_FIELD} value={csrfToken} />
      {children}
      <div className="admin-form-footer">
        {state.message ? (
          <p className={state.status === "success" ? "admin-form-success" : "admin-form-error"} role="status">
            {state.message}
          </p>
        ) : <span />}
        <button className="admin-primary-button" disabled={pending} type="submit">
          {pending ? "Enregistrement…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
