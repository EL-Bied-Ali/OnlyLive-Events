const API_BASE = "https://api-psp.charipay.ma";
const OPERATION_ID = 281;
const ORDER_ID = "15caf6a3-373d-41ba-875b-0f4b87e9dfc1";
const PAYMENT_ID = "4c38a366-1c92-40c0-974f-519f21ddeab2";
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!apiKey) {
  console.log("CHARIPAY_TRANSACTION_MATCH=" + JSON.stringify({ ok:false, error:"missing_api_key" }));
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

function tx(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    operationId:value.operationId ?? null,
    chariOperationId:value.chariOperationId ?? null,
    type:value.type ?? null,
    status:value.status ?? null,
    amount:value.amount ?? null,
    currency:value.currency ?? null,
    direction:value.direction ?? null,
    method:value.method ?? null,
    channel:value.channel ?? null,
    externalReference:value.externalReference ?? null,
    gatewayReferenceId:value.gatewayReferenceId ?? null,
    createdAt:value.createdAt ?? null,
    executedAt:value.executedAt ?? null,
  };
}

function listItems(body) {
  if (Array.isArray(body?.data)) return body.data.map(tx);
  if (Array.isArray(body?.content)) return body.content.map(tx);
  if (Array.isArray(body)) return body.map(tx);
  return [];
}

const [detail, byOrder, byPayment] = await Promise.all([
  get(`/v1/transactions/${OPERATION_ID}`),
  get(`/v1/transactions?type=PAYMENT&status=SUCCESS&search=${encodeURIComponent(ORDER_ID)}&limit=20`),
  get(`/v1/transactions?type=PAYMENT&status=SUCCESS&search=${encodeURIComponent(PAYMENT_ID)}&limit=20`),
]);

console.log("CHARIPAY_TRANSACTION_MATCH=" + JSON.stringify({
  detailHttpStatus:detail.status,
  detail:tx(detail.body),
  orderSearchHttpStatus:byOrder.status,
  orderSearch:listItems(byOrder.body),
  paymentSearchHttpStatus:byPayment.status,
  paymentSearch:listItems(byPayment.body),
}));
