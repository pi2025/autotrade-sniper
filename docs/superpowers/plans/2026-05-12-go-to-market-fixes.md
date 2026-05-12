# Go-to-Market Fixes — AutoTrade Sniper V15 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 blockers empêchant un go-to-market stable sur Netlify + Render.

**Architecture:** Corrections chirurgicales sur 5 fichiers. Aucun algorithme touché. Les routes API protégées par `requireAuth` nécessitent `Authorization: Bearer <VITE_APP_PASSWORD>` — pattern déjà établi dans `AgentCenter.tsx` et `deleteSignal`.

**Tech Stack:** TypeScript, React 19, Express 5, Vite, Supabase, GitHub Actions + Netlify

---

## File Map

| Fichier | Changement |
|---|---|
| `context/SignalsContext.tsx:358-397` | Ajout header `Authorization` sur 3 fetch POST |
| `server.ts:113-133` | Guard `CTRADER_LIVE` avant `placeOrder` |
| `.github/workflows/deploy-netlify.yml:51` | `production-branch: main` |
| `supabase_schema.sql` | DDL des 3 tables reconstruites depuis le code |
| `docs/go-to-market-checklist.md` | Ajout items de vérification |

---

## Task 1: Auth headers manquants — `toggleEngine`, `setStrategy`, `clearMuted`

**Files:**
- Modify: `context/SignalsContext.tsx:358-397`

Ces 3 appels POST frappent des routes protégées par `requireAuth` (lignes 621, 625, 640 de `server.ts`) mais n'envoient pas le header `Authorization`. Résultat : 401 Unauthorized en production.

- [ ] **Étape 1 : Modifier `toggleEngine` (ligne ~360)**

Remplacer :
```typescript
const res = await fetch('/api/engine/toggle', { method: 'POST' });
```
Par :
```typescript
const res = await fetch('/api/engine/toggle', {
  method: 'POST',
  headers: { Authorization: `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}` },
});
```

- [ ] **Étape 2 : Modifier `setStrategy` (ligne ~375)**

Remplacer :
```typescript
const res = await fetch('/api/engine/strategy', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ strategyId: id })
});
```
Par :
```typescript
const res = await fetch('/api/engine/strategy', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}`,
  },
  body: JSON.stringify({ strategyId: id }),
});
```

- [ ] **Étape 3 : Modifier `clearMuted` (ligne ~391)**

Remplacer :
```typescript
const res = await fetch('/api/engine/unmute', { method: 'POST' });
```
Par :
```typescript
const res = await fetch('/api/engine/unmute', {
  method: 'POST',
  headers: { Authorization: `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}` },
});
```

- [ ] **Étape 4 : Vérifier que `deleteSignal` (ligne ~277) a déjà son header**

Confirmer que cette ligne existe et est inchangée :
```typescript
headers: { 'Authorization': `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}` },
```

- [ ] **Étape 5 : Commit**
```bash
git add context/SignalsContext.tsx
git commit -m "fix: add Authorization header to engine toggle/strategy/unmute calls"
```

---

## Task 2: Guard `CTRADER_LIVE` — `executeSignalById`

**Files:**
- Modify: `server.ts:113-133`

En demo, `CTRADER_LIVE` est absent ou `"false"`. Sans guard, un bug ou une mauvaise config pourrait quand même appeler `placeOrder`. On bloque explicitement si `CTRADER_LIVE !== 'true'`.

- [ ] **Étape 1 : Modifier `executeSignalById`**

Remplacer le bloc complet (lignes 113–133) :
```typescript
async function executeSignalById(idOrPrefix: string): Promise<OrderResult & { signal?: Signal }> {
  const signal = findActiveSignalById(idOrPrefix);
  if (!signal) return { error: 'Signal non trouvé' };
  if (signal.ctraderPositionId) return { error: 'Déjà exécuté', positionId: signal.ctraderPositionId, signal };

  if (process.env.CTRADER_LIVE !== 'true') {
    console.warn(`⛔ CTRADER_LIVE != 'true' — ordre bloqué pour ${signal.asset}. Passez CTRADER_LIVE=true pour activer le trading live.`);
    return { error: "Mode demo actif (CTRADER_LIVE != 'true'). Ordre non envoyé.", signal };
  }

  try {
    if (!ctraderService.isConnected()) {
      await ctraderService.init();
    }

    const accountInfo = await ctraderService.getAccountInfo();
    const result = await ctraderService.placeOrder(signal, accountInfo.balance, agentController.getPositionSizing());
    if (result.positionId) {
      signal.ctraderPositionId = result.positionId;
      if (supabase) await supabase.from('signals').update({ content: signal }).eq('id', signal.id);
    }
    return { ...result, signal };
  } catch (e: any) {
    return { error: e.message ?? String(e), signal };
  }
}
```

- [ ] **Étape 2 : Commit**
```bash
git add server.ts
git commit -m "fix: block cTrader placeOrder when CTRADER_LIVE != 'true'"
```

---

## Task 3: CI/CD — `production-branch` → `main`

**Files:**
- Modify: `.github/workflows/deploy-netlify.yml:51`

Actuellement `production-branch: fix/security-audit` → merger sur `main` crée un preview deploy Netlify, pas un deploy de production. À corriger avant le merge final.

- [ ] **Étape 1 : Modifier le workflow**

Remplacer :
```yaml
production-branch: fix/security-audit
```
Par :
```yaml
production-branch: main
```

- [ ] **Étape 2 : Vérifier que le trigger reste sur `main` ET `fix/security-audit`**

S'assurer que le bloc `on.push.branches` contient toujours les deux (déjà le cas ligne 6–7) — ça permet de tester le deploy depuis la branche courante avant le merge.

- [ ] **Étape 3 : Commit**
```bash
git add .github/workflows/deploy-netlify.yml
git commit -m "fix: set Netlify production-branch to main for go-to-market"
```

---

## Task 4: Schéma Supabase — `supabase_schema.sql`

**Files:**
- Modify: `supabase_schema.sql`

Fichier actuellement vide. Schéma reconstruit depuis `server.ts` et `services/agentController.ts`. Permet de recréer la base de zéro en cas de disaster recovery.

- [ ] **Étape 1 : Écrire le DDL dans `supabase_schema.sql`**

```sql
-- AutoTrade Sniper V15 — Supabase Schema
-- Recréer dans cet ordre (pas de FK cross-tables)

-- Signaux actifs
CREATE TABLE IF NOT EXISTS signals (
  id        TEXT PRIMARY KEY,
  asset     TEXT,
  content   JSONB NOT NULL
);

-- Historique des trades clôturés
CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY,
  asset       TEXT,
  pnl         NUMERIC,
  closed_at   TIMESTAMPTZ,
  content     JSONB NOT NULL
);

-- Configuration persistante de l'agent (mode, limites)
-- Clés utilisées : 'agent_mode', 'agent_limits'
CREATE TABLE IF NOT EXISTS app_config (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- Index pour les requêtes courantes
CREATE INDEX IF NOT EXISTS idx_history_closed_at ON history (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_asset     ON signals (asset);
```

- [ ] **Étape 2 : Activer Row Level Security (RLS) recommandé**

Ajouter après les CREATE TABLE :
```sql
-- RLS: seul le service role peut écrire (anon key = lecture seule)
ALTER TABLE signals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- Policy lecture publique (le frontend lit les signaux)
CREATE POLICY "read_signals"    ON signals    FOR SELECT USING (true);
CREATE POLICY "read_history"    ON history    FOR SELECT USING (true);
CREATE POLICY "read_app_config" ON app_config FOR SELECT USING (true);
```

> **Note :** Les écritures (INSERT/UPDATE/DELETE) sont faites depuis `server.ts` avec la clé `VITE_SUPABASE_KEY`. Si cette clé est `anon`, ajouter des policies d'écriture ou utiliser la `service_role` key côté serveur.

- [ ] **Étape 3 : Commit**
```bash
git add supabase_schema.sql
git commit -m "docs: add Supabase schema DDL for disaster recovery"
```

---

## Task 5: Mise à jour de la checklist go-to-market

**Files:**
- Modify: `docs/go-to-market-checklist.md`

- [ ] **Étape 1 : Ajouter les nouveaux items dans Pre-Launch Checks**

Ajouter à la section `## Pre-Launch Checks` :
```markdown
- Auth headers présents sur toutes les routes POST protégées (toggle, strategy, unmute)
- `CTRADER_LIVE` absent ou `false` → `/api/agent/execute/:id` retourne une erreur explicite, pas un ordre
- Schéma Supabase versionné dans `supabase_schema.sql`
```

- [ ] **Étape 2 : Commit**
```bash
git add docs/go-to-market-checklist.md
git commit -m "docs: update go-to-market checklist with new verification items"
```

---

## Task 6: Vérification finale

- [ ] **Étape 1 : Lint**
```bash
npm.cmd run lint
```
Expected: 0 erreurs TypeScript.

- [ ] **Étape 2 : Build**
```bash
npm.cmd run build
```
Expected: `dist/` généré sans erreur, `✓ built in Xs`.

- [ ] **Étape 3 : Vérifier les 5 commits**
```bash
git log --oneline -6
```
Expected: les 5 commits des tasks 1–5 apparaissent.

- [ ] **Étape 4 : Merger sur main**
```bash
git checkout main
git merge fix/security-audit --no-ff -m "fix: go-to-market security and config fixes"
git push origin main
```
Expected: GitHub Actions déclenche le deploy Netlify en production (car `production-branch: main`).
