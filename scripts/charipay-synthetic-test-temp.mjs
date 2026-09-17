const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const DELIVERY_ID = "74eb5c63-e365-4030-be13-4fe215adce02";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_SYNTHETIC_RECHECK=" + JSON.stringify({ ok: false, error: "missing_api_key" }));
  process.exit(0);
}

async function get(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(API_BASE + path, {
      headers: { "X-CHARI-PAY-API-KEY": apiKey },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

const [endpoint, event] = await Promise.all([
  get(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`),
  get(`/api/v1/partner/webhooks/events/${DELIVERY_ID}`),
]);

console.log("CHARIPAY_SYNTHETIC_RECHECK=" + JSON.stringify({
  endpointHttpStatus: endpoint.status,
  endpoint: endpoint.body && typeof endpoint.body === "object" ? {
    id: endpoint.body.id ?? null,
    enabled: endpoint.body.enabled ?? null,
    status: endpoint.body.status ?? null,
    consecutiveFailures: endpoint.body.consecutiveFailures ?? null,
    totalDeliveries: endpoint.body.totalDeliveries ?? null,
    successfulDeliveries: endpoint.body.successfulDeliveries ?? null,
    failedDeliveries: endpoint.body.failedDeliveries ?? null,
    lastDeliveryAt: endpoint.body.lastDeliveryAt ?? null,
    lastSuccessAt: endpoint.body.lastSuccessAt ?? null,
    lastFailureAt: endpoint.body.lastFailureAt ?? null,
    lastError: endpoint.body.lastError ?? null,
  } : null,
  eventHttpStatus: event.status,
  event: event.body && typeof event.body === "object" ? {
    id: event.body.id ?? null,
    eventId: event.body.eventId ?? null,
    eventType: event.body.eventType ?? null,
    endpointId: event.body.endpointId ?? null,
    status: event.body.status ?? null,
    attemptCount: event.body.attemptCount ?? null,
    maxAttempts: event.body.maxAttempts ?? null,
    errorMessage: event.body.errorMessage ?? null,
    lastAttemptAt: event.body.lastAttemptAt ?? null,
    nextRetryAt: event.body.nextRetryAt ?? null,
  } : null,
}));
