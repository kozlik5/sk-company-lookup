-- 002_add_nace_codes.sql
--
-- Adds NACE Rev. 2 codes column to `companies` so the table can be filtered
-- by economic activity (e.g. 43.91 = roofing) without external RPO API calls.
--
-- Source: RPO opendata SQL dump produced by Slovensko.Digital
--   (https://s3.eu-central-1.amazonaws.com/ekosystem-slovensko-digital-dumps/rpo.sql.gz)
-- Format: Postgres COPY dump, contains rpo.organization_economic_activity_entries
--         (organization_id, economic_activity_code, economic_activity_description,
--          valid_from, valid_to/effective_to)
--
-- ALTER TABLE ADD COLUMN with no default and a NULL value is a metadata-only
-- change in Postgres >= 11, so this is safe to run online against a 1M-row table.
-- The GIN index build is non-blocking (CREATE INDEX CONCURRENTLY can't run inside
-- a transaction, so it's split out and intended to be invoked separately when
-- applied via a migration runner that does not wrap each statement).

-- Up
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS nace_codes TEXT[];

COMMENT ON COLUMN companies.nace_codes IS
  'NACE Rev. 2 economic activity codes (e.g. 43.91 = roofing) backfilled from RPO opendata';

-- GIN index for `nace_codes && ARRAY['43.91']` containment queries.
-- Use CONCURRENTLY when applying against a live table (must run outside txn).
CREATE INDEX IF NOT EXISTS idx_companies_nace_gin
  ON companies USING GIN (nace_codes);

-- Down (manual rollback only)
-- DROP INDEX IF EXISTS idx_companies_nace_gin;
-- ALTER TABLE companies DROP COLUMN IF EXISTS nace_codes;
