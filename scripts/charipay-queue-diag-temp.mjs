const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_QUEUE_AFTER_ACTIVATE=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
  process.exit(0);
}

async function get(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(API_BASE + path, {
      headers:{ "X-CHARI-PAY-API-KEY":apiKey },
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

await new Promise((resolve) => setTimeout(resolve, 3000));
const [endpointRes, eventsRes] = await Promise.all([
  get(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`),
  get(`/api/v1/partner/webhooks/events?endpointId=${ENDPOINT_ID}&page=0&size=100`),
]);
const events = Array.isArray(eventsRes.body?.content) ? eventsRes.body.content : [];

console.log("CHARIPAY_QUEUE_AFTER_ACTIVATE=" + JSON.stringify({
  endpoint:endpointRes.body && typeof endpointRes.body === "object" ? {
    enabled:endpointRes.body.enabled ?? null,
    status:endpointRes.body.status ?? null,
    consecutiveFailures:endpointRes.body.consecutiveFailures ?? null,
    totalDeliveries:endpointRes.body.totalDeliveries ?? null,
    successfulDeliveries:endpointRes.body.successfulDeliveries ?? null,
    failedDeliveries:endpointRes.body.failedDeliveries ?? null,
    lastDeliveryAt:endpointRes.body.lastDeliveryAt ?? null,
    lastSuccessAt:endpointRes.body.lastSuccessAt ?? null,
    lastFailureAt:endpointRes.body.lastFailureAt ?? null,
    lastError:endpointRes.body.lastError ?? null,
  } : null,
  events:events.map((event) => ({
    id:event.id ?? null,
    eventType:event.eventType ?? null,
    status:event.status ?? null,
    attemptCount:event.attemptCount ?? null,
    createdAt:event.createdAt ?? null,
    lastAttemptAt:event.lastAttemptAt ?? null,
    nextRetryAt:event.nextRetryAt ?? null,
    errorMessage:event.errorMessage ?? null,
  })),
}));
