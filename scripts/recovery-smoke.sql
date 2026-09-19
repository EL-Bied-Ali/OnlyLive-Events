-- OnlyLive post-restore sanity checks.
-- Read-only: this file contains no INSERT/UPDATE/DELETE/DDL.
-- Run with:
--   psql "$RESTORE_DRILL_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/recovery-smoke.sql
--
-- Each result must be zero. The final DO block makes psql exit non-zero if
-- any invariant is violated.

\pset pager off

SELECT count(*) AS inventory_violations
FROM inventory
WHERE total_quantity < 0
   OR reserved_quantity < 0
   OR sold_quantity < 0
   OR reserved_quantity + sold_quantity > total_quantity;

SELECT count(*) AS usable_ticket_state_violations
FROM tickets t
JOIN order_items oi ON oi.id = t.order_item_id
JOIN orders o ON o.id = oi.order_id
WHERE t.status = 'valid'
  AND o.status NOT IN ('paid', 'partially_refunded');

SELECT count(*) AS impossible_ticket_order_violations
FROM tickets t
JOIN order_items oi ON oi.id = t.order_item_id
JOIN orders o ON o.id = oi.order_id
WHERE o.status IN (
  'pending_payment',
  'failed',
  'cancelled',
  'paid_but_unfulfillable',
  'reconciliation_required'
);

SELECT count(*) AS ticket_identity_violations
FROM tickets t
JOIN order_items oi ON oi.id = t.order_item_id
JOIN orders o ON o.id = oi.order_id
WHERE t.ticket_category_id <> oi.ticket_category_id
   OR t.event_id <> o.event_id;

SELECT count(*) AS paid_payment_order_state_violations
FROM payments p
JOIN orders o ON o.id = p.order_id
WHERE p.status = 'paid'
  AND o.status NOT IN (
    'paid',
    'partially_refunded',
    'refunded',
    'paid_but_unfulfillable',
    'reconciliation_required'
  );

SELECT count(*) AS paid_order_payment_state_violations
FROM orders o
WHERE o.status IN ('paid', 'partially_refunded', 'refunded')
  AND NOT EXISTS (
    SELECT 1
    FROM payments p
    WHERE p.order_id = o.id
      AND p.status IN ('paid', 'partially_refunded', 'refunded')
  );

SELECT CASE
  WHEN to_regclass('public._prisma_migrations') IS NULL THEN 1
  ELSE 0
END AS prisma_migration_table_violations;

SELECT CASE
  WHEN to_regclass('public._prisma_migrations') IS NULL THEN 0
  ELSE (
    SELECT count(*)
    FROM _prisma_migrations
    WHERE finished_at IS NULL
      AND rolled_back_at IS NULL
  )
END AS unfinished_prisma_migration_violations;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory
    WHERE total_quantity < 0
       OR reserved_quantity < 0
       OR sold_quantity < 0
       OR reserved_quantity + sold_quantity > total_quantity
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: inventory invariant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tickets t
    JOIN order_items oi ON oi.id = t.order_item_id
    JOIN orders o ON o.id = oi.order_id
    WHERE (
      t.status = 'valid'
      AND o.status NOT IN ('paid', 'partially_refunded')
    ) OR o.status IN (
      'pending_payment',
      'failed',
      'cancelled',
      'paid_but_unfulfillable',
      'reconciliation_required'
    )
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: ticket/order state invariant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tickets t
    JOIN order_items oi ON oi.id = t.order_item_id
    JOIN orders o ON o.id = oi.order_id
    WHERE t.ticket_category_id <> oi.ticket_category_id
       OR t.event_id <> o.event_id
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: ticket identity invariant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'paid'
      AND o.status NOT IN (
        'paid',
        'partially_refunded',
        'refunded',
        'paid_but_unfulfillable',
        'reconciliation_required'
      )
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: paid payment/order state invariant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.status IN ('paid', 'partially_refunded', 'refunded')
      AND NOT EXISTS (
        SELECT 1
        FROM payments p
        WHERE p.order_id = o.id
          AND p.status IN ('paid', 'partially_refunded', 'refunded')
      )
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: paid order/payment state invariant';
  END IF;

  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'recovery smoke failed: _prisma_migrations missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _prisma_migrations
    WHERE finished_at IS NULL
      AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'recovery smoke failed: unfinished Prisma migration';
  END IF;
END
$$;

SELECT 'recovery smoke checks passed' AS result;
