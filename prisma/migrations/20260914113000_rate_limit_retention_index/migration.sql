-- The primary key begins with "key" and cannot efficiently support the
-- retention job's range deletion on window_start alone.
CREATE INDEX "rate_limit_buckets_window_start_idx" ON "rate_limit_buckets"("window_start");
