ALTER TABLE "events"
ADD COLUMN "max_tickets_per_user" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "events"
ADD CONSTRAINT "events_max_tickets_per_user_check"
CHECK ("max_tickets_per_user" >= 1 AND "max_tickets_per_user" <= 1000);
