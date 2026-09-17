import { NextResponse } from "next/server";

const CHARIPAY_API_BASE_URL = "https://api-psp.charipay.ma";
const TIMEOUT_MS = 10_000;

function sanitizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    const bypass = url.searchParams.get("x-vercel-protection-bypass");
    return {
      origin: url.origin,
      pathname: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()])],
      bypassQueryPresent: Boolean(bypass),
      bypassQueryMatchesEnv: bypass
        ? bypass === process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        : null,
    };
  } catch {
    return { invalidUrl: true };
  }
}

function sanitize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));

  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [childKey, childValue] of Object.entries(source)) {
      if (childKey === "customHeaders" && childValue && typeof childValue === "object") {
        const headers = childValue as Record<string, unknown>;
        const bypass = headers["x-vercel-protection-bypass"]
          ?? headers["X-Vercel-Protection-Bypass"];
        out.customHeaders = {
          keys: Object.keys(headers),
          bypassHeaderPresent: typeof bypass === "string",
          bypassHeaderMatchesEnv: typeof bypass === "string"
            ? bypass === process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            : null,
        };
        continue;
      }

      if (childKey.toLowerCase() === "url" && typeof childValue === "string") {
        out.url = sanitizeUrl(childValue);
        continue;
      }

      if (/secret|signature|authorization|token|api.?key/i.test(childKey)) {
        out[childKey] = "[redacted]";
        continue;
      }

      if (/payload|requestBody|responseBody/i.test(childKey)) {
        out[childKey] = "[redacted]";
        continue;
      }

      out[childKey] = sanitize(childValue, childKey);
    }

    return out;
  }

  if (/secret|signature|authorization|token|api.?key/i.test(key)) return "[redacted]";
  return value;
}

async function chariGet(path: string) {
  const apiKey = process.env.CHARIPAY_API_KEY?.trim();
  if (!apiKey) throw new Error("CHARIPAY_API_KEY is not configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${CHARIPAY_API_BASE_URL}${path}`, {
      headers: { "X-CHARI-PAY-API-KEY": apiKey },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Keep non-JSON text for status-only diagnostics; it is sanitized below.
    }
    return { status: response.status, body: sanitize(body) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview" || process.env.CHARIPAY_ENV !== "sandbox") {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const [endpoints, events] = await Promise.all([
      chariGet("/api/v1/partner/webhooks/endpoints?page=0&size=50"),
      chariGet("/api/v1/partner/webhooks/events?page=0&size=20"),
    ]);

    return NextResponse.json({
      vercelAutomationBypassSecretPresent: Boolean(
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim(),
      ),
      endpoints,
      events,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown diagnostic error",
      },
      { status: 500 },
    );
  }
}
