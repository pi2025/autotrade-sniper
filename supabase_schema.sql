-- AutoTrade Sniper V15 — Supabase Schema
-- Reconstruite depuis server.ts et services/agentController.ts
-- Recréer dans cet ordre (pas de FK cross-tables)

-- Signaux actifs (trades ouverts)
CREATE TABLE IF NOT EXISTS signals (
  id      TEXT PRIMARY KEY,
  asset   TEXT,
  content JSONB NOT NULL
);

-- Historique des trades clôturés
CREATE TABLE IF NOT EXISTS history (
  id         TEXT PRIMARY KEY,
  asset      TEXT,
  pnl        NUMERIC,
  closed_at  TIMESTAMPTZ,
  content    JSONB NOT NULL
);

-- Configuration persistante de l'agent
-- Clés gérées : 'agent_mode' (AgentMode), 'agent_limits' (AgentLimits JSON)
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Index pour les requêtes courantes
CREATE INDEX IF NOT EXISTS idx_history_closed_at ON history (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset     ON signals (asset);

-- Row Level Security
ALTER TABLE signals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- Lecture publique (le frontend React lit signaux et historique)
CREATE POLICY "read_signals"    ON signals    FOR SELECT USING (true);
CREATE POLICY "read_history"    ON history    FOR SELECT USING (true);
CREATE POLICY "read_app_config" ON app_config FOR SELECT USING (true);

-- Les écritures viennent du backend Render via la clé anon.
-- Si RLS bloque les écritures, ajouter les policies ci-dessous ou
-- passer à la service_role key côté serveur :
--
-- CREATE POLICY "write_signals"    ON signals    FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "write_history"    ON history    FOR ALL USING (true) WITH CHECK (true);
-- CREATE POLICY "write_app_config" ON app_config FOR ALL USING (true) WITH CHECK (true);
