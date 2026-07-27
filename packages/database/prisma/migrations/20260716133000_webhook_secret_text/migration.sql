-- "secret" was VARCHAR(100). The application stores the signing secret
-- encrypted, and the ciphertext of a generated secret is 118 characters, so
-- creating a webhook endpoint failed whenever ENCRYPTION_KEY was set.
-- Widening to TEXT loses nothing, and the previous release reads and writes
-- the column as before.
ALTER TABLE "webhook_endpoints" ALTER COLUMN "secret" SET DATA TYPE TEXT;
