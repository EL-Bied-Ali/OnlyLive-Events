const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_SECOND_ACTIVATE=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
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

const before = await listEvents();
const activate = await request(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}/activate`, { method:"POST" });
await new Promise((resolve) => setTimeout(resolve, 5000));
const after = await listEvents();

console.log("CHARIPAY_SECOND_ACTIVATE=" + JSON.stringify({
  activateHttpStatus:activate.status,
  before,
  after,
}));
