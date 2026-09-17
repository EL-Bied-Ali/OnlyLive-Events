const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const OLDEST_RETRY_ID = "8a1ab408-977e-410d-9339-ac2fd57af05d";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_ACTIVATE_PROBE=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
  process.exit(0);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(API_BASE + path, {
      ...init,
      headers: {
        "X-CHARI-PAY-API-KEY": apiKey,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status:response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

const before = await request(`/api/v1/partner/webhooks/events/${OLDEST_RETRY_ID}`);
const activate = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}/activate`, { method:"POST" });
await new Promise((resolve) => setTimeout(resolve, 5000));
const [after, endpoint] = await Promise.all([
  request(`/api/v1/partner/webhooks/events/${OLDEST_RETRY_ID}`),
  request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`),
]);

function eventSummary(body) {
  return body && typeof body === "object" ? {
    status:body.status ?? null,
    attemptCount:body.attemptCount ?? null,
    lastAttemptAt:body.lastAttemptAt ?? null,
    nextRetryAt:body.nextRetryAt ?? null,
    errorMessage:body.errorMessage ?? null,
  } : null;
}

console.log("CHARIPAY_ACTIVATE_PROBE=" + JSON.stringify({
  before:eventSummary(before.body),
  activateHttpStatus:activate.status,
  activateKeys:activate.body && typeof activate.body === "object" ? Object.keys(activate.body) : [],
  activateCode:activate.body?.error?.code ?? activate.body?.code ?? null,
  after:eventSummary(after.body),
  endpoint:endpoint.body && typeof endpoint.body === "object" ? {
    enabled:endpoint.body.enabled ?? null,
    status:endpoint.body.status ?? null,
    consecutiveFailures:endpoint.body.consecutiveFailures ?? null,
    lastDeliveryAt:endpoint.body.lastDeliveryAt ?? null,
    lastSuccessAt:endpoint.body.lastSuccessAt ?? null,
    lastFailureAt:endpoint.body.lastFailureAt ?? null,
  } : null,
}));
