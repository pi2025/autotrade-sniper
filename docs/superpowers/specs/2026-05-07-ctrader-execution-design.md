# Spec : Exécution Automatisée cTrader — IC Markets

**Date :** 2026-05-07  
**Projet :** AutoTrade Sniper V15  
**Broker :** IC Markets (EU) — compte démo `9932624`  
**Plateforme :** cTrader Open API v2 (WebSocket TLS + Protobuf)  
**Statut :** Approuvé

---

## 1. Objectif

Connecter le moteur de signaux V15 (qui tourne en 24/7 sur `server.ts`) au compte cTrader IC Markets pour exécuter automatiquement les ordres de trading. Le système supporte 4 modes d'exécution contrôlables depuis un Agent Control Center dédié.

---

## 2. Architecture Globale

```
marketEngine.ts (signal généré)
        │
        ▼
agentController.ts ──── gardes de risque (trades max, risque total, drawdown)
        │
   mode=AUTONOMOUS      mode=SEMI_AUTO         mode=SIGNALS_ONLY
        │                     │                       │
        ▼                     ▼                    (inchangé)
ctraderService.ts    Telegram + bouton
  placeOrder()       "✅ Exécuter"
  amendSL()               │
  closePosition()         ▼
        │          POST /api/agent/execute/:id
        ▼                 │
  cTrader API             ▼
  IC Markets       ctraderService.ts
  Demo/Live
```

---

## 3. Nouveaux Fichiers

### 3.1 `services/ctraderService.ts`

**Responsabilité :** Gestion de la connexion WebSocket TLS au serveur Spotware et exécution des ordres via le protocole Protobuf.

**Endpoints :**
- Demo : `wss://demo.ctraderapi.com:5036`
- Live : `wss://live.ctraderapi.com:5036`

**Séquence d'authentification au démarrage :**
1. `connect()` — ouvre la socket WebSocket TLS
2. `applicationAuth(clientId, clientSecret)` → `ProtoOAApplicationAuthReq`
3. `accountAuth(accessToken, accountId)` → `ProtoOAAccountAuthReq`
4. `heartbeat()` toutes les 10 secondes → `ProtoHeartbeatEvent`
5. `reconnect()` automatique avec backoff exponentiel (1s, 2s, 4s, max 30s)

**Variables d'environnement requises :**
```
CTRADER_CLIENT_ID=...
CTRADER_CLIENT_SECRET=...
CTRADER_ACCESS_TOKEN=...       # token OAuth2 du compte
CTRADER_ACCOUNT_ID=9932624
CTRADER_LIVE=false             # false = demo, true = live
```

**Fonctions publiques :**

| Fonction | Protobuf | Retour |
|---|---|---|
| `placeOrder(signal)` | `ProtoOANewOrderReq` | `{ positionId?: string, error?: string }` |
| `amendSL(positionId, newSL, newTP?)` | `ProtoOAAmendPositionSLTPReq` | `{ success: boolean }` |
| `closePosition(positionId)` | `ProtoOAClosePositionReq` | `{ success: boolean }` |
| `getAccountInfo()` | `ProtoOATraderReq` | `{ balance: number, equity: number }` |
| `getOpenPositions()` | `ProtoOAReconcileReq` | `OandaOpenTrade[]` |

**Calcul des unités (adapté depuis oandaService du worktree) :**
- Forex USD-quoté (EURUSD, GBPUSD, AUDUSD…) : `units = riskAmount / slDistance`
- Forex USD-base (USDJPY, USDCAD, USDCHF) : `units = (riskAmount × price) / slDistance`
- Indices / Commodités : `units = floor(riskAmount / slDistance)`
- Plafond de sécurité : 100 000 unités (1 lot standard)
- `riskAmount` = `balance × (effectiveRiskPercent / 100)` (intègre le `ASSET_RISK_MULTIPLIER` existant)

**Mapping Yahoo → cTrader symbolName :**
```
EURUSD=X → EURUSD    GBPUSD=X → GBPUSD    USDJPY=X → USDJPY
AUDUSD=X → AUDUSD    USDCAD=X → USDCAD    USDCHF=X → USDCHF
NZDUSD=X → NZDUSD    EURGBP=X → EURGBP    EURJPY=X → EURJPY
GBPJPY=X → GBPJPY    AUDJPY=X → AUDJPY    CHFJPY=X → CHFJPY
EURNZD=X → EURNZD    GBPAUD=X → GBPAUD    CADJPY=X → CADJPY
EURCHF=X → EURCHF    GC=F    → XAUUSD     SI=F    → XAGUSD
CL=F    → USOIL       BTC-USD → BTCUSD     ETH-USD → ETHUSD
SOL-USD → SOLUSD      BNB-USD → BNBUSD     XRP-USD → XRPUSD
^GSPC   → SP500       ^IXIC   → NAS100     ^FCHI   → FRA40
```

**Gestion des erreurs :**
- `SYMBOL_NOT_FOUND` → log + retour `{ error }`, pas de crash
- `NOT_ENOUGH_MONEY` → log + alerte Telegram, pas de crash
- Déconnexion → reconnect automatique, orders en queue si déconnecté

---

### 3.2 `services/agentController.ts`

**Responsabilité :** Décision d'exécution basée sur le mode actif et les gardes de risque. Surveillance du drawdown.

**Types :**
```ts
type AgentMode = 'SIGNALS_ONLY' | 'SEMI_AUTO' | 'AUTONOMOUS' | 'EMERGENCY_STOP';

interface AgentLimits {
  maxSimultaneousTrades: number;   // défaut: 3
  maxRiskPercent: number;          // défaut: 5 (% du solde)
  maxDrawdownPercent: number;      // défaut: 15 (% depuis le pic)
}

interface ExecutionDecision {
  execute: boolean;
  mode: AgentMode;
  reason?: string;
}
```

**`shouldExecute(signal, activeSignals)` — gardes dans l'ordre :**
1. `mode === EMERGENCY_STOP` → `{ execute: false, reason: 'Arrêt d'urgence actif' }`
2. `mode === SIGNALS_ONLY` → `{ execute: false }`
3. `activeSignals.length >= limits.maxSimultaneousTrades` → `{ execute: false, reason: 'Trades max atteint' }`
4. `riskTotalOuvert + signal.riskAmount > balance × (limits.maxRiskPercent / 100)` → `{ execute: false, reason: 'Risque total dépassé' }`
5. `mode === SEMI_AUTO` → `{ execute: false, mode: 'SEMI_AUTO' }` (déclenchera l'envoi Telegram avec bouton)
6. `mode === AUTONOMOUS` → `{ execute: true }`

**Surveillance drawdown (appelée dans la boucle principale toutes les 5 min) :**
```
equity < peakEquity × (1 − limits.maxDrawdownPercent / 100)
  → forcer mode = EMERGENCY_STOP
  → closeAllPositions() sur cTrader
  → alerte Telegram : "🚨 DRAWDOWN MAX ATTEINT — Toutes positions fermées"
```

**Persistance :**
- Mode et limites lus/écrits dans `app_config` Supabase (table existante)
- Clés : `agent_mode`, `agent_limits`
- Chargés au démarrage du serveur, mis à jour via les endpoints API

---

### 3.3 `pages/AgentCenter.tsx`

**Responsabilité :** Interface de contrôle de l'agent (page dédiée `/agent`).

**Composants :**
- **Mode Selector** : 4 boutons (SIGNAUX SEULS, SEMI-AUTO, AUTONOME, ARRÊT D'URGENCE) avec confirmation pour AUTONOME et ARRÊT D'URGENCE
- **Risk Limits Form** : 3 champs numériques (trades max, risque %, drawdown %) + bouton SAUVEGARDER
- **cTrader Status** : indicateur connexion (vert/rouge), solde, équité, nb positions ouvertes
- **Positions Live** : tableau des positions cTrader actuellement liées aux signaux actifs

**Polling :** `GET /api/agent/status` toutes les 10s (même intervalle que le sync existant dans `SignalsContext.tsx`).

---

## 4. Modifications des Fichiers Existants

### 4.1 `types.ts`
Ajout sur l'interface `Signal` :
```ts
ctraderPositionId?: string;
```
Ajout des nouveaux types `AgentMode` et `AgentLimits`.

### 4.2 `server.ts`

**Initialisation (après chargement Supabase) :**
```ts
await agentController.init();   // charge mode + limites depuis app_config
await ctraderService.connect(); // si mode !== SIGNALS_ONLY
```

**Hook 1 — Nouveau signal validé (ligne ~289) :**
```ts
const decision = await agentController.shouldExecute(newSignal, activeSignals);
if (decision.execute) {
  const result = await ctraderService.placeOrder(newSignal);
  if (result.positionId) newSignal.ctraderPositionId = result.positionId;
} else if (decision.mode === 'SEMI_AUTO') {
  // Le message Telegram existant est remplacé par un message avec bouton inline
  await sendTelegramWithExecuteButton(newSignal);
}
```

**Hook 2 — Breakeven activé (ligne ~229) :**
```ts
if (existing.ctraderPositionId) {
  await ctraderService.amendSL(existing.ctraderPositionId, existing.priceAtSignal);
}
```

**Hook 3 — Clôture Chandelier (ligne ~243) :**
```ts
// Tentative de clôture sur cTrader. Si la position est déjà fermée côté broker
// (SL/TP natif atteint), closePosition() retourne { success: false, alreadyClosed: true }
// et on synchronise l'état sans erreur.
if (existing.ctraderPositionId) {
  await ctraderService.closePosition(existing.ctraderPositionId);
  // Silencieux si alreadyClosed: true — simple sync d'état
}
```

**Sync périodique des positions cTrader (toutes les 5 min dans la boucle principale) :**
Pour détecter les positions fermées côté broker sans action de l'app (SL/TP natif atteint avant le Chandelier), la boucle appelle `getOpenPositions()` et réconcilie avec `activeSignals`. Tout signal avec `ctraderPositionId` absent de la liste broker est considéré clôturé et basculé en historique.

**Nouveaux endpoints API :**
```
GET  /api/agent/status         → mode, limites, balance cTrader, positions ouvertes
POST /api/agent/mode           → { mode: AgentMode }
POST /api/agent/limits         → { maxSimultaneousTrades, maxRiskPercent, maxDrawdownPercent }
POST /api/agent/execute/:id    → exécute manuellement un signal actif (SEMI_AUTO)
POST /api/agent/emergency-stop → ferme tout, arrête moteur
```

### 4.3 `App.tsx`
Ajout de la route `/agent` pointant vers `AgentCenter.tsx`.

### 4.4 `components/Layout.tsx`
Ajout du lien "Agent" dans la navigation principale.

---

## 5. Base de Données Supabase

Aucune nouvelle table. Ajout de 2 lignes dans `app_config` (table existante) :

```sql
INSERT INTO app_config (key, value) VALUES
  ('agent_mode',   '"SIGNALS_ONLY"'),
  ('agent_limits', '{"maxSimultaneousTrades":3,"maxRiskPercent":5,"maxDrawdownPercent":15}')
ON CONFLICT (key) DO NOTHING;
```

---

## 6. Packages npm à Installer

```bash
npm install protobufjs
```
`ws` est déjà disponible via les dépendances transitives Express/Vite. `protobufjs` encode/décode les messages Spotware Protobuf.

---

## 7. Variables d'Environnement à Configurer

```env
CTRADER_CLIENT_ID=<depuis onglet Credentials sur connect.spotware.com>
CTRADER_CLIENT_SECRET=<depuis onglet Credentials sur connect.spotware.com>
CTRADER_ACCESS_TOKEN=<token OAuth2 obtenu via le flux d'autorisation>
CTRADER_ACCOUNT_ID=9932624
CTRADER_LIVE=false
```

---

## 8. Flux Semi-Auto Telegram

1. Signal validé par le moteur
2. `agentController.shouldExecute()` retourne `{ execute: false, mode: 'SEMI_AUTO' }`
3. Telegram envoie message avec inline keyboard :
   ```
   🚀 SIGNAL SNIPER — EUR/USD LONG
   Entrée: 1.1754 | TP: 1.1808 | SL: 1.1719
   Confiance: 80%
   [✅ EXÉCUTER]  [❌ IGNORER]
   ```
4. Bouton "EXÉCUTER" → callback vers `POST /api/agent/execute/:signalId`
5. Bouton "IGNORER" → supprime le signal (comportement `DELETE /api/signals/:id` existant)

---

## 9. Comportement EMERGENCY_STOP

1. Appel `POST /api/agent/emergency-stop`
2. `ctraderService.closePosition()` sur chaque `ctraderPositionId` des signaux actifs
3. `activeSignals = []`
4. `isEngineRunning = false`
5. `mode = 'EMERGENCY_STOP'`
6. Persist en Supabase `app_config`
7. Alerte Telegram : `🚨 ARRÊT D'URGENCE ACTIVÉ — Toutes positions fermées`

---

## 10. Hors Scope

- Synchronisation inverse (positions ouvertes sur cTrader non générées par l'app)
- Gestion des ordres partiellement remplis
- Mode live (production) — uniquement demo pour cette implémentation
- Interface web pour le flux OAuth2 (l'access token est configuré manuellement)
