import { NextResponse } from "next/server";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }

  // Never leak internal error details (stack traces, DB errors, etc.) to
  // the client — log server-side only, return a generic message.
  console.error(error);
  return NextResponse.json({ error: "INTERNAL_ERROR", message: "Something went wrong" }, { status: 500 });
}
