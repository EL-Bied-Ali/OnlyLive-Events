-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('pending', 'processing', 'sent', 'failed');

-- DropTable
DROP TABLE "email_logs";

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_started_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_status_next_attempt_at_idx" ON "email_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_type_entity_type_entity_id_key" ON "email_outbox"("type", "entity_type", "entity_id");
