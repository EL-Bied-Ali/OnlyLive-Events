const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_SYNTHETIC_TEST=" + JSON.stringify({ ok: false, error: "missing_api_key" }));
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
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

function safeEvent(body) {
  if (!body || typeof body !== "object") return null;
  return {
    id: body.id ?? null,
    eventId: body.eventId ?? null,
    eventType: body.eventType ?? null,
    endpointId: body.endpointId ?? null,
    status: body.status ?? null,
    attemptCount: body.attemptCount ?? null,
    maxAttempts: body.maxAttempts ?? null,
    errorMessage: body.errorMessage ?? null,
    lastAttemptAt: body.lastAttemptAt ?? null,
    nextRetryAt: body.nextRetryAt ?? null,
    responseStatus: body.responseStatus ?? body.httpStatus ?? null,
  };
}

const startedAt = Date.now();
const queued = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}/test`, { method: "POST" });
let deliveryId = queued.body?.deliveryId ?? queued.body?.id ?? null;

if (!deliveryId) {
  const list = await request("/api/v1/partner/webhooks/events?page=0&size=20");
  const events = Array.isArray(list.body?.content) ? list.body.content : [];
  const candidate = events
    .filter((event) => event?.endpointId === ENDPOINT_ID)
    .filter((event) => {
      const ts = Date.parse(event?.createdAt ?? "");
      return Number.isFinite(ts) && ts >= startedAt - 15000;
    })
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))[0];
  deliveryId = candidate?.id ?? null;
}

let latest = null;
if (deliveryId) {
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const detail = await request(`/api/v1/partner/webhooks/events/${deliveryId}`);
    latest = { httpStatus: detail.status, event: safeEvent(detail.body) };
    const status = detail.body?.status;
    if (status && !["pending", "retrying", "queued"].includes(status)) break;
  }
}

console.log("CHARIPAY_SYNTHETIC_TEST=" + JSON.stringify({
  queueHttpStatus: queued.status,
  queueResponseKeys: queued.body && typeof queued.body === "object" ? Object.keys(queued.body) : [],
  deliveryIdPresent: Boolean(deliveryId),
  latest,
}));
