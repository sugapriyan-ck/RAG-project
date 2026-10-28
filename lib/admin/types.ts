// Shared admin form-state types. Kept out of the "use server" module so both
// server actions and client components can import them.

export interface ActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export const idleActionState: ActionState = { status: "idle", message: "" };
