const API_BASE = "https://api-psp.charipay.ma";
const DELIVERY_ID = "aca45366-ae14-4a1b-a049-493a84f54135";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_TRANSACTION_SHAPE=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
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

function safeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = [
    "operationId","id","type","status","amount","currency","method","channel",
    "externalId","reference","customData","gatewayOrderId","gatewayReferenceId",
    "gatewayTrackId","createdAt","updatedAt","metadata","orderId","refundReference",
  ];
  return {
    keys:Object.keys(value).sort(),
    selected:Object.fromEntries(
      allowed
        .filter((key) => Object.prototype.hasOwnProperty.call(value,key))
        .map((key) => [key, value[key]])
    ),
  };
}

const eventRes = await get(`/api/v1/partner/webhooks/events/${DELIVERY_ID}`);
const event = eventRes.body && typeof eventRes.body === "object" ? eventRes.body : null;
const payload = event?.payload ?? event?.requestBody ?? event?.body ?? null;
const payloadObject = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
const operationId = payloadObject?.OperationId ?? payloadObject?.operationId ?? null;

let detailRes = { status:0, body:null };
if (operationId !== null && operationId !== undefined) {
  detailRes = await get(`/v1/transactions/${encodeURIComponent(String(operationId))}`);
}
const listRes = await get("/v1/transactions?type=PAYMENT&status=SUCCESS&limit=20");
const listItems = Array.isArray(listRes.body?.content)
  ? listRes.body.content
  : Array.isArray(listRes.body?.items)
    ? listRes.body.items
    : Array.isArray(listRes.body)
      ? listRes.body
      : [];

console.log("CHARIPAY_TRANSACTION_SHAPE=" + JSON.stringify({
  eventHttpStatus:eventRes.status,
  eventPayload:safeObject(payloadObject),
  operationIdPresent:operationId !== null && operationId !== undefined,
  detailHttpStatus:detailRes.status,
  transactionDetail:safeObject(detailRes.body),
  listHttpStatus:listRes.status,
  listTopLevelKeys:listRes.body && typeof listRes.body === "object" && !Array.isArray(listRes.body)
    ? Object.keys(listRes.body).sort()
    : [],
  listItems:listItems.slice(0,10).map(safeObject),
}));
