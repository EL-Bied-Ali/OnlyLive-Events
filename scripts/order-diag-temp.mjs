import pg from "pg";

const ORDER_ID = "222ee9ff-1235-4fa7-8f36-91ae7b2d5740";
const API_BASE = "https://api-psp.charipay.ma";
const databaseUrl = process.env.DATABASE_URL?.trim();
const apiKey = process.env.CHARIPAY_API_KEY?.trim();

if (!databaseUrl || !apiKey) {
  console.log("ORDER_DIAG=" + JSON.stringify({
    ok:false,
    databasePresent:Boolean(databaseUrl),
    apiKeyPresent:Boolean(apiKey),
  }));
  process.exit(0);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

async function chari(path) {
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

try {
  const q = await client.query(
    `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.status AS order_status,
        o.total_amount_cents,
        o.currency,
        o.expires_at,
        p.id AS payment_id,
        p.provider,
        p.provider_payment_id,
        p.status AS payment_status,
        p.created_at AS payment_created_at,
        p.updated_at AS payment_updated_at
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    [ORDER_ID],
  );
  const row = q.rows[0] ?? null;

  let session = null;
  let transactions = null;

  if (row?.provider_payment_id) {
    const res = await chari(`/v1/payment-sessions/${encodeURIComponent(row.provider_payment_id)}`);
    session = {
      httpStatus:res.status,
      body:res.body && typeof res.body === "object" ? {
        keys:Object.keys(res.body).sort(),
        status:res.body.status ?? null,
        paid:res.body.paid ?? null,
        sessionIdPresent:Boolean(res.body.sessionId ?? res.body.id),
      } : null,
    };
  }

  const tx = await chari(`/v1/transactions?type=PAYMENT&search=${encodeURIComponent(ORDER_ID)}&limit=20`);
  const items = Array.isArray(tx.body?.data) ? tx.body.data : [];
  transactions = {
    httpStatus:tx.status,
    count:items.length,
    items:items.map((item) => ({
      operationId:item.operationId ?? null,
      status:item.status ?? null,
      amount:item.amount ?? null,
      currency:item.currency ?? null,
      externalReference:item.externalReference ?? null,
      createdAt:item.createdAt ?? null,
      executedAt:item.executedAt ?? null,
    })),
  };

  console.log("ORDER_DIAG=" + JSON.stringify({
    ok:true,
    order:row ? {
      orderNumber:row.order_number,
      orderStatus:row.order_status,
      totalAmountCents:row.total_amount_cents,
      currency:row.currency,
      expiresAt:row.expires_at,
      paymentIdPresent:Boolean(row.payment_id),
      provider:row.provider,
      providerPaymentIdPresent:Boolean(row.provider_payment_id),
      paymentStatus:row.payment_status,
      paymentCreatedAt:row.payment_created_at,
      paymentUpdatedAt:row.payment_updated_at,
    } : null,
    session,
    transactions,
  }));
} finally {
  await client.end();
}
