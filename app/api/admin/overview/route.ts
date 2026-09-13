import { NextResponse } from "next/server";
import { requireAdminRole } from "@/lib/auth/admin";
import { getAdminMetrics } from "@/lib/admin/dashboard";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminRole(["super_admin", "admin", "support"]);
    const metrics = await getAdminMetrics();
    return NextResponse.json({ metrics });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
