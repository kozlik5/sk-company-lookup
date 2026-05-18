-- 003_new_companies_tracking.sql
--
-- Tracks the first time each IČO appears in the `companies` table after an
-- RPO import. `companies` is rebuilt from scratch on every import, so we
-- cannot derive "new this week" from `imported_at` directly — instead we
-- accumulate a side table that only ever grows.
--
-- Post-import (see ImportService.recordNewIcos), we INSERT ICOs that are
-- present in `companies` but absent from `seen_icos`, stamping them with
-- today's date. The weekly query then filters `first_seen >= NOW() - 7d`.
--
-- Backfill: on first deploy, we insert every current ICO with a sentinel
-- date (today) so the first weekly run is empty rather than reporting the
-- entire ~1.1M company set as "new".

-- Up
CREATE TABLE IF NOT EXISTS seen_icos (
  ico         VARCHAR(20) PRIMARY KEY,
  first_seen  DATE NOT NULL DEFAULT CURRENT_DATE,
  legal_form  TEXT,
  name        TEXT,
  city        TEXT,
  nace_codes  TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_seen_icos_first_seen
  ON seen_icos (first_seen DESC);

CREATE INDEX IF NOT EXISTS idx_seen_icos_nace_gin
  ON seen_icos USING GIN (nace_codes);

COMMENT ON TABLE seen_icos IS
  'Append-only ledger of IČOs first observed in each RPO import — feeds the weekly "new companies" digest.';

-- Down (manual rollback only)
-- DROP INDEX IF EXISTS idx_seen_icos_nace_gin;
-- DROP INDEX IF EXISTS idx_seen_icos_first_seen;
-- DROP TABLE IF EXISTS seen_icos;
