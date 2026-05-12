-- Migration RLS — AutoTrade Sniper V15
-- À exécuter UNE FOIS dans Supabase Dashboard → SQL Editor
-- (si les tables existent déjà et que les écritures sont bloquées)

-- Activer RLS sur les tables existantes (idempotent)
ALTER TABLE signals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- Policies de lecture (DROP IF EXISTS pour idempotence)
DROP POLICY IF EXISTS "read_signals"    ON signals;
DROP POLICY IF EXISTS "read_history"    ON history;
DROP POLICY IF EXISTS "read_app_config" ON app_config;

CREATE POLICY "read_signals"    ON signals    FOR SELECT USING (true);
CREATE POLICY "read_history"    ON history    FOR SELECT USING (true);
CREATE POLICY "read_app_config" ON app_config FOR SELECT USING (true);

-- Policies d'écriture (nécessaires avec clé anon)
DROP POLICY IF EXISTS "write_signals"    ON signals;
DROP POLICY IF EXISTS "write_history"    ON history;
DROP POLICY IF EXISTS "write_app_config" ON app_config;

CREATE POLICY "write_signals"    ON signals    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_history"    ON history    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_app_config" ON app_config FOR ALL USING (true) WITH CHECK (true);
