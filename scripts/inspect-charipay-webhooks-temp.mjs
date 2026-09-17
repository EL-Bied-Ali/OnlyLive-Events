const API_BASE = "https://api-psp.charipay.ma";
const TIMEOUT_MS = 10000;

function currentSecrets() {
  return [
    process.env.CHARIPAY_API_KEY,
    process.env.CHARIPAY_WEBHOOK_SECRET,
    process.env.CHARIPAY_WEBHOOK_SECRET_NEXT,
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function redactString(value) {
  let out = String(value);
  for (const secret of currentSecrets()) {
    out = out.split(secret).join("[redacted]");
  }
  return out.length > 500 ? out.slice(0, 500) + "…[truncated]" : out;
}

function summarizeUrl(raw) {
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

function sanitize(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));

  if (value && typeof value === "object") {
    const source = value;
    const out = {};
    for (const [childKey, childValue] of Object.entries(source)) {
      const lower = childKey.toLowerCase();

      if (childKey === "customHeaders" && childValue && typeof childValue === "object") {
        const headers = childValue;
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

      if (lower === "url" && typeof childValue === "string") {
        out.url = summarizeUrl(childValue);
        continue;
      }

      if (/secret|signature|authorization|token|api.?key/.test(lower)) {
        out[childKey] = "[redacted]";
        continue;
      }

      if (/payload|requestbody|responsebody/.test(lower)) {
        out[childKey] = "[redacted]";
        continue;
      }

      out[childKey] = sanitize(childValue, childKey);
    }
    return out;
  }

  if (typeof value === "string") return redactString(value);
  return value;
}

async function get(path) {
  const apiKey = process.env.CHARIPAY_API_KEY?.trim();
  if (!apiKey) return { status: 0, error: "CHARIPAY_API_KEY missing" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(API_BASE + path, {
      headers: { "X-CHARI-PAY-API-KEY": apiKey },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status, body: sanitize(body) };
  } catch (error) {
    return {
      status: 0,
      error: redactString(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

if (process.env.VERCEL_ENV === "preview" && process.env.CHARIPAY_ENV === "sandbox") {
  const [endpoints, events] = await Promise.all([
    get("/api/v1/partner/webhooks/endpoints?page=0&size=50"),
    get("/api/v1/partner/webhooks/events?page=0&size=20"),
  ]);

  console.log("CHARIPAY_DIAG=" + JSON.stringify({
    vercelAutomationBypassSecretPresent: Boolean(
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim(),
    ),
    endpoints,
    events,
  }));
}
