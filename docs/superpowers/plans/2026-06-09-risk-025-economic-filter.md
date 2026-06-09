# Risk 0.25% + Filtre Économique Actif — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réduire le risque par trade à 0.25% et brancher le filtre calendrier économique réel dans le pipeline agent avant tout appel Groq.

**Architecture:** Deux changements indépendants et ciblés. (1) Insertion d'un guard `isHighImpactEventSoon` dans la boucle `topCandidates` de `server.ts`, après les filtres blacklist/quota, avant `runTechnicalAnalysis`. (2) Mise à jour de `DEFAULT_CONFIG.maxRiskPerTrade` dans `riskAgent.ts` de 1.0 à 0.25. L'env var Render `CTRADER_RISK_PERCENT=0.25` est mis à jour manuellement après déploiement.

**Tech Stack:** TypeScript/Node, npx tsx (scripts de vérification), Render (env vars)

---

## File Map

| Fichier | Action | Rôle |
|---|---|---|
| `server.ts` | Modifier ligne 530 | Ajouter guard économique dans boucle topCandidates |
| `services/agents/riskAgent.ts` | Modifier ligne 34 | Changer maxRiskPerTrade de 1.0 à 0.25 |
| `scripts/test-economic-filter.ts` | Créer | Vérifier que isHighImpactEventSoon retourne le bon format |
| Render dashboard | Manuel | Mettre `CTRADER_RISK_PERCENT=0.25` dans les env vars |

---

## Task 1 — Script de vérification du filtre économique

**Files:**
- Create: `scripts/test-economic-filter.ts`

- [ ] **Step 1 : Créer le script de vérification**

```typescript
#!/usr/bin/env npx tsx
/**
 * scripts/test-economic-filter.ts — Vérifie que isHighImpactEventSoon retourne
 * le bon format et ne plante pas pour les différents types d'actifs.
 * Usage : npx tsx scripts/test-economic-filter.ts
 */

import { config } from 'dotenv';
config({ path: '.env' });
config({ path: '.env.vercel.local' });

import { isHighImpactEventSoon } from '../services/economicCalendarService.ts';

let passed = 0;
let failed = 0;

function ok(label: string) { console.log(`  ✅ ${label}`); passed++; }
function fail(label: string, detail?: any) { console.error(`  ❌ ${label}`, detail ?? ''); failed++; }

async function main() {
  console.log('\n📅 Test du filtre économique\n');

  // Test 1 — Actif forex USD mappé : doit retourner { isSoon: boolean, events: array }
  console.log('Test 1 : EURUSD=X — retour bien formé');
  const r1 = await isHighImpactEventSoon('EURUSD=X', 60);
  if (typeof r1.isSoon === 'boolean' && Array.isArray(r1.events)) ok('retour formé { isSoon, events }');
  else fail('retour malformé', r1);

  // Test 2 — Actif non mappé : doit retourner { isSoon: false, events: [] }
  console.log('Test 2 : UNKNOWN=X — doit retourner isSoon=false');
  const r2 = await isHighImpactEventSoon('UNKNOWN=X', 60);
  if (r2.isSoon === false && r2.events.length === 0) ok('isSoon=false, events=[] pour actif inconnu');
  else fail('inattendu pour actif inconnu', r2);

  // Test 3 — Chaque événement doit avoir title, currency, minutesUntil
  console.log('Test 3 : Structure des événements retournés');
  const r3 = await isHighImpactEventSoon('GBPUSD=X', 60 * 24 * 7); // fenêtre large pour trouver des events
  const malformed = r3.events.filter(e => typeof e.title !== 'string' || typeof e.currency !== 'string' || typeof e.minutesUntil !== 'number');
  if (malformed.length === 0) ok(`${r3.events.length} événements bien formés`);
  else fail(`${malformed.length} événements malformés`, malformed[0]);

  console.log(`\n${passed} passés, ${failed} échoués`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2 : Exécuter le script pour confirmer que le service fonctionne**

```bash
npx tsx scripts/test-economic-filter.ts
```

Sortie attendue :
```
📅 Test du filtre économique

Test 1 : EURUSD=X — retour bien formé
  ✅ retour formé { isSoon, events }
Test 2 : UNKNOWN=X — doit retourner isSoon=false
  ✅ isSoon=false, events=[] pour actif inconnu
Test 3 : Structure des événements retournés
  ✅ N événements bien formés

3 passés, 0 échoués
```

Si le script échoue avec une erreur réseau sur `nfs.faireconomy.media` : le service est down temporairement (réessayer dans 5 min). Si erreur d'import : vérifier le chemin `../services/economicCalendarService.ts`.

- [ ] **Step 3 : Commit du script de vérification**

```bash
git add scripts/test-economic-filter.ts
git commit -m "test: vérification du filtre économique isHighImpactEventSoon"
```

---

## Task 2 — Brancher le filtre dans server.ts

**Files:**
- Modify: `server.ts:530`

- [ ] **Step 1 : Localiser le point d'insertion**

Dans `server.ts`, trouver le bloc (autour de la ligne 530) :

```typescript
        // Filtre max 2 trades/jour/actif
        const todayCount = dailyTradeCount[candidate.asset.symbol] || 0;
        if (todayCount >= MAX_TRADES_PER_DAY_PER_ASSET) {
          console.log(`📅 Quota journalier atteint: ${candidate.asset.symbol} (${todayCount}/${MAX_TRADES_PER_DAY_PER_ASSET})`);
          scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'REJECTED', reason: `Quota journalier atteint (${todayCount}/${MAX_TRADES_PER_DAY_PER_ASSET} trades/jour)` }, ...scanLogs].slice(0, MAX_LOGS);
          continue;
        }

        try {
          // Agent 2 — Analyste Technique IA
          const technical = await runTechnicalAnalysis(candidate);
```

- [ ] **Step 2 : Insérer le filtre économique après le bloc quota, avant le `try {`**

Remplacer :
```typescript
        try {
          // Agent 2 — Analyste Technique IA
          const technical = await runTechnicalAnalysis(candidate);
```

Par :
```typescript
        // Filtre économique — avant les agents Groq (coût $0, données réelles)
        const ecoCheck = await isHighImpactEventSoon(candidate.asset.symbol, 60);
        if (ecoCheck.isSoon) {
          const labels = ecoCheck.events.map(e => `${e.currency} ${e.title} (${e.minutesUntil >= 0 ? `dans ${e.minutesUntil}min` : `il y a ${Math.abs(e.minutesUntil)}min`})`).join(' | ');
          console.log(`📅 Rejet économique ${candidate.asset.symbol}: ${labels}`);
          scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'ECONOMIC_BLOCK', reason: `Annonce imminente: ${labels}` }, ...scanLogs].slice(0, MAX_LOGS);
          continue;
        }

        try {
          // Agent 2 — Analyste Technique IA
          const technical = await runTechnicalAnalysis(candidate);
```

Note : `isHighImpactEventSoon` est déjà importé à la ligne 10 de server.ts — aucun import à ajouter.

- [ ] **Step 3 : Vérifier que le build TypeScript ne retourne pas d'erreur**

```bash
npx tsc --noEmit
```

Sortie attendue : aucune erreur. Si erreur `Property 'status' does not exist` sur l'objet scanLogs : vérifier que `'ECONOMIC_BLOCK'` est une valeur acceptée dans le type `ScanLog` de `types.ts`. Si ce n'est pas le cas, utiliser `'REJECTED'` à la place et ajuster le `reason`.

- [ ] **Step 4 : Commit**

```bash
git add server.ts
git commit -m "feat: filtre économique actif avant agents Groq (isHighImpactEventSoon)"
```

---

## Task 3 — Réduire le risque à 0.25% dans riskAgent.ts

**Files:**
- Modify: `services/agents/riskAgent.ts:34`

- [ ] **Step 1 : Modifier DEFAULT_CONFIG**

Dans `services/agents/riskAgent.ts`, changer :
```typescript
const DEFAULT_CONFIG: RiskConfig = {
  maxOpenPositions: 5,
  maxRiskPerTrade: 1.0,
  maxCorrelatedPositions: 2,
  maxDailyLosses: 3,
};
```

En :
```typescript
const DEFAULT_CONFIG: RiskConfig = {
  maxOpenPositions: 5,
  maxRiskPerTrade: 0.25,
  maxCorrelatedPositions: 2,
  maxDailyLosses: 3,
};
```

- [ ] **Step 2 : Vérifier le build**

```bash
npx tsc --noEmit
```

Sortie attendue : aucune erreur.

- [ ] **Step 3 : Commit**

```bash
git add services/agents/riskAgent.ts
git commit -m "feat: risque par trade réduit à 0.25% (décision CEO post walk-forward)"
```

---

## Task 4 — Mettre à jour l'env var sur Render (manuel)

**Files:**
- Render dashboard (hors code)

- [ ] **Step 1 : Déployer le code sur Render**

Push sur `main` déclenche le déploiement automatique via GitHub Actions (ou Render auto-deploy).

```bash
git push origin main
```

Vérifier dans le dashboard Render que le déploiement termine sans erreur.

- [ ] **Step 2 : Mettre à jour CTRADER_RISK_PERCENT sur Render**

Dans le dashboard Render → Service `autotrade-sniper-api` → Environment :

Changer : `CTRADER_RISK_PERCENT=1`  
En : `CTRADER_RISK_PERCENT=0.25`

Cliquer "Save Changes" → Render redémarre le service automatiquement.

- [ ] **Step 3 : Vérifier dans les logs Render**

Dans les logs du service après redémarrage, chercher :
- `🤖 AgentController initialisé` → confirme le démarrage
- `📅 Rejet économique` sur un actif forex pendant une annonce → confirme le filtre actif
- Aucun `riskPercent: 1` dans les décisions agent → confirme 0.25% effectif

---

## Task 5 — Vérification finale en démo

- [ ] **Step 1 : Laisser tourner 1 cycle complet (~5 min) et vérifier les logs**

Dans les logs Render, confirmer :
1. Au moins un `ECONOMIC_BLOCK` visible lors d'une annonce HIGH impact (ou absence de signaux forex pendant NFP/CPI si aucun n'est imminent — normal)
2. `riskAmount` dans les signaux générés ≈ 0.25 (ou une fraction si performanceAgent réduit le multiplicateur)
3. Aucun crash sur le nouvel appel `isHighImpactEventSoon` (erreur réseau vers Forex Factory = warn, non bloquant)

- [ ] **Step 2 : Confirmer CTRADER_LIVE=false dans les logs**

Les logs doivent montrer `demo.ctraderapi.com` dans les connexions cTrader, pas `live.ctraderapi.com`. Le passage au live est une étape séparée, après validation démo.

---

## Checklist finale (critères de "terminé" de la spec)

- [ ] Logs Render montrent `ECONOMIC_BLOCK` sur actif forex pendant annonce HIGH impact
- [ ] `riskAmount` des signaux ≈ 0.25
- [ ] `CTRADER_RISK_PERCENT=0.25` confirmé dans Render env vars
- [ ] Aucune régression pipeline (blacklist, quota, R:R minimum toujours actifs)
- [ ] `CTRADER_LIVE` reste `false`
