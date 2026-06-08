-- 003_rls_secure.sql
-- Supprime les policies d'écriture publique (USING true / WITH CHECK true).
-- Le serveur utilise désormais SUPABASE_SERVICE_KEY qui bypasse RLS nativement :
-- aucune policy d'écriture explicite n'est nécessaire côté serveur.
-- La lecture publique (SELECT USING true) reste inchangée pour le frontend (clé anon).
--
-- AVANT d'appliquer : vérifier que server.ts utilise bien SUPABASE_SERVICE_KEY
-- et que le test scripts/test-rls.ts passe en vert.

-- Noms réels des policies dans la base (vérifiés via pg_policies le 2026-06-08)
DROP POLICY IF EXISTS "Enable access for all users" ON signals;
DROP POLICY IF EXISTS "Enable access for all users" ON history;
DROP POLICY IF EXISTS "Enable access for all users" ON app_config;
DROP POLICY IF EXISTS "Enable access for all users" ON scan_logs;
DROP POLICY IF EXISTS "Public Access Snapshots" ON market_snapshots;
DROP POLICY IF EXISTS "Public Insert Access" ON push_subscriptions;
-- cloud_pulse : aucune policy d'écriture publique trouvée — rien à supprimer
