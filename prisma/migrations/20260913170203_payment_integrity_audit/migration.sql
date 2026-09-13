-- DropIndex
DROP INDEX "reservations_user_id_idx";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "redirect_url" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "order_items_reservation_id_key" ON "order_items"("reservation_id");

-- CreateIndex
CREATE INDEX "reservations_user_id_status_idx" ON "reservations"("user_id", "status");

-- CreateIndex
CREATE INDEX "reservations_sales_phase_id_status_idx" ON "reservations"("sales_phase_id", "status");

