-- Zapne Row-Level Security na všetkých verejných tabuľkách, ktoré ho nemajú.
-- Rieši Supabase advisor: rls_disabled_in_public (tabuľky verejne čitateľné/zapisovateľné
-- cez PostgREST/anon). App sa pripája ako postgres superuser cez pooler → RLS obchádza,
-- takže import ani API sa nerozbijú; zavrie sa len verejná diera.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
    RAISE NOTICE 'RLS enabled on public.%', r.relname;
  END LOOP;
END $$;
