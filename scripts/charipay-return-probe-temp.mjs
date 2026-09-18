import pg from "pg";

const ORDER_ID = "222ee9ff-1235-4fa7-8f36-91ae7b2d5740";
const OPERATION_ID = 286;
const API_BASE = "https://api-psp.charipay.ma";
const databaseUrl = process.env.DATABASE_URL?.trim();
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!databaseUrl || !apiKey) {
  console.log("CHARIPAY_STUCK_3DS_DIAG=" + JSON.stringify({ ok:false }));
  process.exit(0);
}

async function api(path) {
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
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(safeObject);
  const allowed = new Set([
    "status","type","event","eventType","name","step","stage","result","code","message",
    "createdAt","timestamp","occurredAt","executedAt","operationId","gatewayReferenceId",
    "responseCode","reasonCode","externalReference","hasMore","nextCursor",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowed.has(key))
      .map(([key,val]) => [key,safeObject(val)])
  );
}

const client = new pg.Client({ connectionString:databaseUrl });
await client.connect();
try {
  const q=await client.query(
    "SELECT provider_payment_id FROM payments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1",
    [ORDER_ID],
  );
  const sessionId=q.rows[0]?.provider_payment_id ?? null;
  const [timeline, journeyEvents, journeySummary, transaction, session] = await Promise.all([
    api(`/v1/transactions/${OPERATION_ID}/timeline`),
    sessionId ? api(`/v1/analytics/journeys/PAYMENT_SESSION/${encodeURIComponent(sessionId)}/events?page=0&size=100`) : Promise.resolve({status:0,body:null}),
    sessionId ? api(`/v1/analytics/journeys/PAYMENT_SESSION/${encodeURIComponent(sessionId)}/summary`) : Promise.resolve({status:0,body:null}),
    api(`/v1/transactions/${OPERATION_ID}`),
    sessionId ? api(`/v1/payment-sessions/${encodeURIComponent(sessionId)}`) : Promise.resolve({status:0,body:null}),
  ]);

  console.log("CHARIPAY_STUCK_3DS_DIAG=" + JSON.stringify({
    sessionIdPresent:Boolean(sessionId),
    transaction:{httpStatus:transaction.status,body:safeObject(transaction.body)},
    session:{httpStatus:session.status,body:safeObject(session.body)},
    timeline:{httpStatus:timeline.status,body:safeObject(timeline.body)},
    journeyEvents:{httpStatus:journeyEvents.status,body:safeObject(journeyEvents.body)},
    journeySummary:{httpStatus:journeySummary.status,body:safeObject(journeySummary.body)},
  }));
} finally {
  await client.end();
}
