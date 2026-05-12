-- AutoTrade Sniper V15 — Supabase Schema (introspection 2026-05-12)
-- Recréer dans cet ordre pour disaster recovery

CREATE TABLE IF NOT EXISTS signals (
  id         TEXT PRIMARY KEY,
  asset      TEXT,
  timeframe  TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS history (
  id         TEXT PRIMARY KEY,
  asset      TEXT,
  pnl        NUMERIC,
  closed_at  TIMESTAMPTZ,
  content    JSONB NOT NULL
);

-- Configuration persistante de l'agent
-- Clés : 'agent_mode' (AgentMode), 'agent_limits' (AgentLimits JSON)
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_logs (
  id        TEXT PRIMARY KEY,
  timestamp BIGINT,
  asset     TEXT,
  timeframe TEXT,
  status    TEXT,
  message   TEXT,
  score     NUMERIC
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  symbol     TEXT PRIMARY KEY,
  price      NUMERIC NOT NULL,
  indicators JSONB,
  timestamp  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_pulse (
  id         TEXT PRIMARY KEY,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription JSONB NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_history_closed_at   ON history (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset        ON signals (asset);
CREATE INDEX IF NOT EXISTS idx_scan_logs_timestamp  ON scan_logs (timestamp DESC);

-- RLS
ALTER TABLE signals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE history          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_pulse      ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Lecture publique
CREATE POLICY "read_signals"    ON signals    FOR SELECT USING (true);
CREATE POLICY "read_history"    ON history    FOR SELECT USING (true);
CREATE POLICY "read_app_config" ON app_config FOR SELECT USING (true);

-- Écriture backend (clé anon depuis Render)
CREATE POLICY "write_signals"    ON signals    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_history"    ON history    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_app_config" ON app_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_scan_logs"  ON scan_logs  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_market_snapshots" ON market_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_cloud_pulse" ON cloud_pulse FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_push_subscriptions" ON push_subscriptions FOR ALL USING (true) WITH CHECK (true);
