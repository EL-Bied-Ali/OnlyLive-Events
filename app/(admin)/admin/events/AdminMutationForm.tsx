"use client";

import { useActionState } from "react";
import {
  INITIAL_ADMIN_ACTION_STATE,
  type AdminActionState,
} from "@/lib/admin/actionState";

interface AdminMutationFormProps {
  action: (state: AdminActionState, formData: FormData) => Promise<AdminActionState>;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
}

export function AdminMutationForm({
  action,
  children,
  submitLabel,
  className = "admin-edit-form",
}: AdminMutationFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_ADMIN_ACTION_STATE);

  return (
    <form action={formAction} className={className}>
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
