-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('order_confirmation', 'payment_failed', 'refund_confirmation');

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_logs_type_entity_type_entity_id_key" ON "email_logs"("type", "entity_type", "entity_id");
