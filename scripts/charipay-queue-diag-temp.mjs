const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_TOGGLE_PROBE=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
  process.exit(0);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(API_BASE + path, {
      ...init,
      headers:{
        "X-CHARI-PAY-API-KEY":apiKey,
        "content-type":"application/json",
        ...(init.headers || {}),
      },
      signal:controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status:response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function listEvents() {
  const res = await request(`/api/v1/partner/webhooks/events?endpointId=${ENDPOINT_ID}&page=0&size=100`);
  const items = Array.isArray(res.body?.content) ? res.body.content : [];
  return items.map((event) => ({
    id:event.id ?? null,
    createdAt:event.createdAt ?? null,
    status:event.status ?? null,
    attemptCount:event.attemptCount ?? null,
    lastAttemptAt:event.lastAttemptAt ?? null,
    nextRetryAt:event.nextRetryAt ?? null,
    errorMessage:event.errorMessage ?? null,
  }));
}

const endpoint = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`);
const e = endpoint.body;
if (!e || typeof e !== "object" || typeof e.url !== "string") {
  console.log("CHARIPAY_TOGGLE_PROBE=" + JSON.stringify({ ok:false, endpointHttpStatus:endpoint.status }));
  process.exit(0);
}

const baseBody = {
  url:e.url,
  description:e.description ?? undefined,
  enabledEvents:Array.isArray(e.enabledEvents) ? e.enabledEvents : undefined,
  customHeaders:e.customHeaders && typeof e.customHeaders === "object" ? e.customHeaders : undefined,
  apiVersion:e.apiVersion ?? undefined,
};

const before = await listEvents();
const disable = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`, {
  method:"PATCH",
  body:JSON.stringify({ ...baseBody, enabled:false }),
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const enable = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`, {
  method:"PATCH",
  body:JSON.stringify({ ...baseBody, enabled:true }),
});
await new Promise((resolve) => setTimeout(resolve, 7000));
const [after, endpointAfter] = await Promise.all([
  listEvents(),
  request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`),
]);

console.log("CHARIPAY_TOGGLE_PROBE=" + JSON.stringify({
  disableHttpStatus:disable.status,
  enableHttpStatus:enable.status,
  before,
  after,
  endpoint:endpointAfter.body && typeof endpointAfter.body === "object" ? {
    enabled:endpointAfter.body.enabled ?? null,
    status:endpointAfter.body.status ?? null,
    consecutiveFailures:endpointAfter.body.consecutiveFailures ?? null,
    totalDeliveries:endpointAfter.body.totalDeliveries ?? null,
    successfulDeliveries:endpointAfter.body.successfulDeliveries ?? null,
    failedDeliveries:endpointAfter.body.failedDeliveries ?? null,
    lastDeliveryAt:endpointAfter.body.lastDeliveryAt ?? null,
    lastSuccessAt:endpointAfter.body.lastSuccessAt ?? null,
    lastFailureAt:endpointAfter.body.lastFailureAt ?? null,
  } : null,
}));
