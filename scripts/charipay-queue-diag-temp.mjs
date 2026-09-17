import crypto from "node:crypto";

const API_BASE = "https://api-psp.charipay.ma";
const ENDPOINT_ID = "77e21777-0e04-44df-9489-c9084671bc84";
const DELIVERY_ID = "74eb5c63-e365-4030-be13-4fe215adce02";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();
const webhookSecret = process.env.CHARIPAY_WEBHOOK_SECRET?.trim();

if (!apiKey || !webhookSecret) {
  console.log("CHARIPAY_DIRECT_RECEIVER_TEST=" + JSON.stringify({
    ok:false,
    error: !apiKey ? "missing_api_key" : "missing_webhook_secret",
  }));
  process.exit(0);
}

async function chariGet(path) {
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

const [endpointRes, eventRes] = await Promise.all([
  chariGet(`/api/v1/partner/webhooks/endpoints/${ENDPOINT_ID}`),
  chariGet(`/api/v1/partner/webhooks/events/${DELIVERY_ID}`),
]);

const endpointUrl = typeof endpointRes.body?.url === "string" ? endpointRes.body.url : null;
const event = eventRes.body && typeof eventRes.body === "object" ? eventRes.body : null;
const payloadCandidate = event?.payload ?? event?.requestBody ?? event?.body ?? null;
const rawBody = typeof payloadCandidate === "string"
  ? payloadCandidate
  : payloadCandidate && typeof payloadCandidate === "object"
    ? JSON.stringify(payloadCandidate)
    : null;
const eventId = typeof event?.eventId === "string" ? event.eventId : null;
const eventType = typeof event?.eventType === "string" ? event.eventType : null;

if (!endpointUrl || !rawBody || !eventId || !eventType) {
  console.log("CHARIPAY_DIRECT_RECEIVER_TEST=" + JSON.stringify({
    ok:false,
    endpointHttpStatus:endpointRes.status,
    eventHttpStatus:eventRes.status,
    endpointUrlPresent:Boolean(endpointUrl),
    eventIdPresent:Boolean(eventId),
    eventTypePresent:Boolean(eventType),
    payloadFieldType: payloadCandidate === null ? "null" : Array.isArray(payloadCandidate) ? "array" : typeof payloadCandidate,
    eventKeys:event ? Object.keys(event) : [],
  }));
  process.exit(0);
}

const timestamp = String(Date.now());
const signature = crypto.createHmac("sha256", webhookSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");

const receiver = await fetch(endpointUrl, {
  method:"POST",
  headers:{
    "content-type":"application/json",
    "x-chari-timestamp":timestamp,
    "x-chari-signature":signature,
    "chari-event-id":eventId,
    "chari-event-type":eventType,
  },
  body:rawBody,
  redirect:"manual",
});

const responseText = await receiver.text();

console.log("CHARIPAY_DIRECT_RECEIVER_TEST=" + JSON.stringify({
  ok: receiver.status >= 200 && receiver.status < 300,
  endpointHttpStatus:endpointRes.status,
  eventHttpStatus:eventRes.status,
  payloadFieldType: typeof payloadCandidate,
  receiverStatus:receiver.status,
  receiverBody:responseText.slice(0,300),
  receiverLocation:receiver.headers.has("location") ? "[present]" : null,
}));
