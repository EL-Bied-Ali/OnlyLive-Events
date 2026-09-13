-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'reconciliation_required';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "provider_init_at" TIMESTAMP(3);

