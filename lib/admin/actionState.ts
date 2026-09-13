export interface AdminActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export const INITIAL_ADMIN_ACTION_STATE: AdminActionState = { status: "idle", message: "" };
