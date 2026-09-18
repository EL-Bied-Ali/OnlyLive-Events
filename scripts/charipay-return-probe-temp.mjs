import pg from "pg";

const ORDER_ID = "222ee9ff-1235-4fa7-8f36-91ae7b2d5740";
const OPERATION_ID = 286;
const API_BASE = "https://api-psp.charipay.ma";
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.log("CHARIPAY_RETURN_PROBE=" + JSON.stringify({ ok:false, error:"missing_database_url" }));
  process.exit(0);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const q = await client.query(
    `
      SELECT p.provider_payment_id
      FROM payments p
      WHERE p.order_id = $1
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    [ORDER_ID],
  );
  const sessionId = q.rows[0]?.provider_payment_id ?? null;
  if (!sessionId) {
    console.log("CHARIPAY_RETURN_PROBE=" + JSON.stringify({ ok:false, error:"missing_session_id" }));
    process.exit(0);
  }

  const before = await fetch(`${API_BASE}/v1/transactions/${OPERATION_ID}`, {
    headers: { "X-CHARI-PAY-API-KEY": process.env.CHARIPAY_API_KEY?.trim() ?? "" },
  });
  const beforeBody = await before.json().catch(() => null);

  const ret = await fetch(`${API_BASE}/checkout/return`, {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body:JSON.stringify({ sessionId, operationId:OPERATION_ID }),
  });
  const retText = await ret.text();
  let retBody = null;
  try { retBody = retText ? JSON.parse(retText) : null; } catch {}

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const after = await fetch(`${API_BASE}/v1/transactions/${OPERATION_ID}`, {
    headers: { "X-CHARI-PAY-API-KEY": process.env.CHARIPAY_API_KEY?.trim() ?? "" },
  });
  const afterBody = await after.json().catch(() => null);

  console.log("CHARIPAY_RETURN_PROBE=" + JSON.stringify({
    ok:true,
    before:{
      httpStatus:before.status,
      status:beforeBody?.status ?? null,
      executedAt:beforeBody?.executedAt ?? null,
    },
    returnCall:{
      httpStatus:ret.status,
      status:retBody?.status ?? null,
      redirectUrlPresent:Boolean(retBody?.redirectUrl),
      errorCode:retBody?.error?.code ?? retBody?.code ?? null,
    },
    after:{
      httpStatus:after.status,
      status:afterBody?.status ?? null,
      executedAt:afterBody?.executedAt ?? null,
    },
  }));
} finally {
  await client.end();
}
