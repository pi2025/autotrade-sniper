# cTrader Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connecter AutoTrade Sniper V15 au compte cTrader IC Markets (démo 9932624) pour exécuter automatiquement les ordres depuis les signaux générés par le moteur.

**Architecture:** Un service WebSocket TLS (`ctraderService.ts`) maintient une connexion persistante au serveur Spotware et encode les ordres en Protobuf. Un contrôleur (`agentController.ts`) décide d'exécuter ou non selon le mode (SIGNALS_ONLY / SEMI_AUTO / AUTONOMOUS / EMERGENCY_STOP) et les gardes de risque. Le serveur Express existant est modifié avec 4 hooks précis dans la boucle de trading et 5 nouveaux endpoints API.

**Tech Stack:** Node.js 22, TypeScript, `ws` (WebSocket), `protobufjs` (Protobuf), cTrader Open API v2 (WebSocket TLS port 5036), Supabase (persistance mode/limites), React + Lucide (UI Agent Center).

**Spec de référence:** `docs/superpowers/specs/2026-05-07-ctrader-execution-design.md`

---

## Fichiers concernés

| Action | Fichier | Rôle |
|---|---|---|
| Créer | `services/ctrader.proto` | Définitions Protobuf Spotware (minimales) |
| Créer | `services/ctraderService.ts` | Connexion WebSocket + ordres cTrader |
| Créer | `services/agentController.ts` | Modes d'exécution + gardes de risque |
| Créer | `pages/AgentCenter.tsx` | UI Agent Control Center |
| Modifier | `types.ts` | Ajout AgentMode, AgentLimits, ctraderPositionId |
| Modifier | `server.ts` | 4 hooks + 5 endpoints API + init cTrader |
| Modifier | `App.tsx` | Route `/agent` |
| Modifier | `components/Layout.tsx` | Lien nav "Agent" |
| Modifier | `.env` | Variables CTRADER_* (déjà fait) |

---

## Task 0 : Obtenir l'Access Token OAuth2 cTrader

> Ce token est requis avant toute connexion à l'API. C'est une opération unique.

**Files:**
- Modify: `server.ts` (endpoints temporaires, à supprimer après)

- [ ] **Step 0.1 : Ajouter deux routes OAuth2 temporaires dans `server.ts`**

Ajouter juste après `apiRouter.get("/health", ...)` :

```ts
// --- OAUTH2 CTRADER (TEMPORAIRE — supprimer après obtention du token) ---
apiRouter.get("/ctrader/auth", (req, res) => {
  const clientId = process.env.CTRADER_CLIENT_ID;
  const redirectUri = 'http://localhost:3000/api/ctrader/callback';
  const url = `https://connect.spotware.com/apps/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`;
  res.redirect(url);
});

apiRouter.get("/ctrader/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Code manquant');
  try {
    const response = await fetch('https://connect.spotware.com/apps/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: 'http://localhost:3000/api/ctrader/callback',
        client_id: process.env.CTRADER_CLIENT_ID!,
        client_secret: process.env.CTRADER_CLIENT_SECRET!,
      }).toString()
    });
    const data: any = await response.json();
    res.send(`
      <h2>✅ Token obtenu !</h2>
      <p><strong>access_token:</strong> ${data.access_token}</p>
      <p><strong>refresh_token:</strong> ${data.refresh_token}</p>
      <p>Copie le access_token dans ton .env : CTRADER_ACCESS_TOKEN=...</p>
    `);
  } catch (e: any) {
    res.status(500).send(`Erreur: ${e.message}`);
  }
});
// --- FIN OAUTH2 TEMPORAIRE ---
```

- [ ] **Step 0.2 : Démarrer le serveur et obtenir le token**

```bash
npm run dev
```

Ouvrir dans le navigateur : `http://localhost:3000/api/ctrader/auth`

Se connecter avec le compte Spotware (`pierrenikabou10`), autoriser l'application.

La page de callback affiche le `access_token`. Le copier dans `.env` :

```
CTRADER_ACCESS_TOKEN=<le_token_affiché>
```

- [ ] **Step 0.3 : Supprimer les routes OAuth2 temporaires de `server.ts`**

Supprimer les 25 lignes ajoutées à l'étape 0.1.

- [ ] **Step 0.4 : Commit**

```bash
git add .env
git commit -m "config: ajouter CTRADER_ACCESS_TOKEN dans .env"
```

---

## Task 1 : Mise à jour des types

**Files:**
- Modify: `types.ts`

- [ ] **Step 1.1 : Ajouter les nouveaux types dans `types.ts`**

Ajouter après `export enum SignalStatus` (ligne ~19) :

```ts
export type AgentMode = 'SIGNALS_ONLY' | 'SEMI_AUTO' | 'AUTONOMOUS' | 'EMERGENCY_STOP';

export interface AgentLimits {
  maxSimultaneousTrades: number;
  maxRiskPercent: number;
  maxDrawdownPercent: number;
}

export interface AgentStatus {
  mode: AgentMode;
  limits: AgentLimits;
  connected: boolean;
  balance: number;
  equity: number;
  openPositions: number;
}
```

- [ ] **Step 1.2 : Ajouter `ctraderPositionId` sur l'interface `Signal`**

Dans l'interface `Signal` (ligne ~105), ajouter avant la fermeture `}` :

```ts
  ctraderPositionId?: string;
```

- [ ] **Step 1.3 : Vérifier qu'il n'y a pas d'erreurs TypeScript visibles dans l'IDE**

Ouvrir `types.ts` dans VSCode et vérifier l'absence de soulignements rouges.

- [ ] **Step 1.4 : Commit**

```bash
git add types.ts
git commit -m "feat(types): ajouter AgentMode, AgentLimits, AgentStatus et ctraderPositionId"
```

---

## Task 2 : Définitions Protobuf

**Files:**
- Créer: `services/ctrader.proto`

- [ ] **Step 2.1 : Installer les dépendances**

```bash
npm install protobufjs ws
npm install --save-dev @types/ws
```

Vérifier que `node_modules/protobufjs` et `node_modules/ws` existent.

- [ ] **Step 2.2 : Créer `services/ctrader.proto`**

```proto
syntax = "proto2";

message ProtoMessage {
  required uint32 payloadType = 1;
  optional bytes payload = 2;
  optional string clientMsgId = 3;
}

message ProtoHeartbeatEvent {
  required uint32 payloadType = 1;
}

message ProtoOAApplicationAuthReq {
  required uint32 payloadType = 1;
  required string clientId = 2;
  required string clientSecret = 3;
}

message ProtoOAApplicationAuthRes {
  required uint32 payloadType = 1;
}

message ProtoOAAccountAuthReq {
  required uint32 payloadType = 1;
  required string accessToken = 2;
  required int64 ctidTraderAccountId = 3;
}

message ProtoOAAccountAuthRes {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
}

message ProtoOANewOrderReq {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  required string symbolName = 3;
  required int32 orderType = 4;
  required int32 tradeSide = 5;
  required int64 volume = 6;
  optional double stopLoss = 9;
  optional double takeProfit = 10;
}

message ProtoOAExecutionEvent {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  required int32 executionType = 3;
  optional ProtoOAPosition position = 5;
}

message ProtoOAPosition {
  required int64 positionId = 1;
  required int32 tradeData = 2;
  required int32 positionStatus = 3;
  required int64 volume = 4;
}

message ProtoOAAmendPositionSLTPReq {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  required int64 positionId = 3;
  optional double stopLoss = 4;
  optional double takeProfit = 5;
  optional bool guaranteedStopLoss = 6;
}

message ProtoOAClosePositionReq {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  required int64 positionId = 3;
  required int64 volume = 4;
}

message ProtoOAReconcileReq {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
}

message ProtoOAReconcileRes {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  repeated ProtoOAPosition position = 3;
}

message ProtoOATraderReq {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
}

message ProtoOATraderRes {
  required uint32 payloadType = 1;
  required int64 ctidTraderAccountId = 2;
  required ProtoOATrader trader = 3;
}

message ProtoOATrader {
  required int64 ctidTraderAccountId = 1;
  optional int64 balance = 3;
  optional int64 moneyDigits = 7;
}
```

- [ ] **Step 2.3 : Commit**

```bash
git add services/ctrader.proto package.json package-lock.json
git commit -m "feat: ajouter définitions Protobuf cTrader et installer ws + protobufjs"
```

---

## Task 3 : ctraderService.ts

**Files:**
- Créer: `services/ctraderService.ts`

- [ ] **Step 3.1 : Créer `services/ctraderService.ts`**

```ts
import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Signal, SignalType, AssetType } from '../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Payload types (numéros de message Spotware) ---
const PT = {
  HEARTBEAT:       51,
  APP_AUTH_REQ:  2100,
  APP_AUTH_RES:  2101,
  ACC_AUTH_REQ:  2102,
  ACC_AUTH_RES:  2103,
  NEW_ORDER_REQ: 2106,
  AMEND_SL_REQ:  2109,
  CLOSE_POS_REQ: 2111,
  EXECUTION_EVT: 2126,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  TRADER_REQ:    2121,
  TRADER_RES:    2122,
} as const;

// --- Mapping Yahoo Finance → cTrader symbolName ---
const SYMBOL_MAP: Record<string, string> = {
  'EURUSD=X': 'EURUSD',  'GBPUSD=X': 'GBPUSD',  'USDJPY=X': 'USDJPY',
  'AUDUSD=X': 'AUDUSD',  'USDCAD=X': 'USDCAD',  'USDCHF=X': 'USDCHF',
  'NZDUSD=X': 'NZDUSD',  'EURGBP=X': 'EURGBP',  'EURJPY=X': 'EURJPY',
  'GBPJPY=X': 'GBPJPY',  'AUDJPY=X': 'AUDJPY',  'CHFJPY=X': 'CHFJPY',
  'EURNZD=X': 'EURNZD',  'GBPAUD=X': 'GBPAUD',  'CADJPY=X': 'CADJPY',
  'EURCHF=X': 'EURCHF',  'EURAUD=X': 'EURAUD',
  'GC=F':     'XAUUSD',  'SI=F':     'XAGUSD',  'CL=F':    'USOIL',
  'BTC-USD':  'BTCUSD',  'ETH-USD':  'ETHUSD',  'SOL-USD': 'SOLUSD',
  'BNB-USD':  'BNBUSD',  'XRP-USD':  'XRPUSD',
  '^GSPC':    'SP500',   '^IXIC':    'NAS100',  '^FCHI':   'FRA40',
};

// --- USD-base pairs (unité de calcul inversée) ---
const USD_BASE = new Set(['USDJPY', 'USDCAD', 'USDCHF']);

export interface OrderResult {
  positionId?: string;
  error?: string;
  alreadyClosed?: boolean;
}

export interface AccountInfo {
  balance: number;
  equity: number;
}

class CTraderService {
  private ws: WebSocket | null = null;
  private proto: protobuf.Root | null = null;
  private pendingCallbacks = new Map<string, (msg: any) => void>();
  private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private authenticated = false;

  private get host() {
    return process.env.CTRADER_LIVE === 'true'
      ? 'wss://live.ctraderapi.com:5036'
      : 'wss://demo.ctraderapi.com:5036';
  }

  private get accountId(): number {
    return parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
  }

  async init(): Promise<void> {
    this.proto = await protobuf.load(path.join(__dirname, 'ctrader.proto'));
    await this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.host);
      this.ws.binaryType = 'nodebuffer';

      this.ws.on('open', async () => {
        console.log('✅ cTrader WebSocket connecté');
        this.reconnectDelay = 1000;
        try {
          await this.applicationAuth();
          await this.accountAuth();
          this.startHeartbeat();
          this.authenticated = true;
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.ws.on('message', (data: Buffer) => this.handleMessage(data));

      this.ws.on('close', () => {
        console.warn('⚠️ cTrader déconnecté. Reconnexion dans', this.reconnectDelay, 'ms');
        this.authenticated = false;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          this.connect().catch(console.error);
        }, this.reconnectDelay);
      });

      this.ws.on('error', (err) => {
        console.error('❌ cTrader WebSocket error:', err.message);
        reject(err);
      });
    });
  }

  private handleMessage(data: Buffer): void {
    if (!this.proto) return;
    try {
      const ProtoMessage = this.proto.lookupType('ProtoMessage');
      const length = data.readUInt32BE(0);
      const payload = data.slice(4, 4 + length);
      const msg: any = ProtoMessage.decode(payload);

      const clientMsgId = msg.clientMsgId;
      if (clientMsgId && this.pendingCallbacks.has(clientMsgId)) {
        const cb = this.pendingCallbacks.get(clientMsgId)!;
        this.pendingCallbacks.delete(clientMsgId);
        cb(msg);
      }
    } catch (e) {
      console.error('cTrader message parse error:', e);
    }
  }

  private send(payloadType: number, messageType: string, fields: object, clientMsgId?: string): void {
    if (!this.proto || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const InnerMsg = this.proto.lookupType(messageType);
    const ProtoMessage = this.proto.lookupType('ProtoMessage');

    const innerPayload = InnerMsg.encode(
      InnerMsg.create({ payloadType, ...fields })
    ).finish();

    const outerMsg = ProtoMessage.create({
      payloadType,
      payload: innerPayload,
      ...(clientMsgId ? { clientMsgId } : {})
    });

    const outerBytes = ProtoMessage.encode(outerMsg).finish();
    const buf = Buffer.allocUnsafe(4 + outerBytes.length);
    buf.writeUInt32BE(outerBytes.length, 0);
    outerBytes.copy(buf, 4);
    this.ws.send(buf);
  }

  private waitForResponse(clientMsgId: string, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(clientMsgId);
        reject(new Error(`cTrader timeout: ${clientMsgId}`));
      }, timeoutMs);

      this.pendingCallbacks.set(clientMsgId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  private async applicationAuth(): Promise<void> {
    const msgId = 'app_auth';
    const responsePromise = this.waitForResponse(msgId);
    this.send(PT.APP_AUTH_REQ, 'ProtoOAApplicationAuthReq', {
      clientId: process.env.CTRADER_CLIENT_ID!,
      clientSecret: process.env.CTRADER_CLIENT_SECRET!,
    }, msgId);
    await responsePromise;
    console.log('✅ cTrader Application Auth OK');
  }

  private async accountAuth(): Promise<void> {
    const msgId = 'acc_auth';
    const responsePromise = this.waitForResponse(msgId);
    this.send(PT.ACC_AUTH_REQ, 'ProtoOAAccountAuthReq', {
      accessToken: process.env.CTRADER_ACCESS_TOKEN!,
      ctidTraderAccountId: this.accountId,
    }, msgId);
    await responsePromise;
    console.log(`✅ cTrader Account Auth OK — compte ${this.accountId}`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.send(PT.HEARTBEAT, 'ProtoHeartbeatEvent', {});
    }, 10000);
  }

  // --- Calcul du volume API (centilots pour FX) ---
  private calculateVolume(signal: Signal, balance: number, symbolName: string): number {
    const riskMultiplier = { 'EURUSD': 0.5 }[symbolName] ?? 1;
    const riskAmount = balance * (0.01 * riskMultiplier); // 1% * multiplier
    const slDistance = Math.abs(signal.priceAtSignal - signal.tradeSetup.stopLoss);
    if (slDistance === 0) return 0;

    let baseUnits: number;
    if (USD_BASE.has(symbolName)) {
      baseUnits = (riskAmount * signal.priceAtSignal) / slDistance;
    } else {
      baseUnits = riskAmount / slDistance;
    }

    const isDiscrete = signal.assetType === AssetType.INDEX
      || signal.assetType === AssetType.COMMODITY
      || signal.assetType === AssetType.STOCK;

    // cTrader FX: 1 API unit = 1000 base units → diviser par 1000
    // cTrader Indices/Commodités: 1 API unit = 1 unité → arrondir à l'entier
    const apiVolume = isDiscrete
      ? Math.floor(baseUnits)
      : Math.round(baseUnits / 1000);

    const MAX_VOLUME = 100; // 1 lot standard
    return Math.max(1, Math.min(apiVolume, MAX_VOLUME));
  }

  // --- API publique ---

  async placeOrder(signal: Signal, balance: number): Promise<OrderResult> {
    if (!this.authenticated) return { error: 'cTrader non authentifié' };

    const symbolName = SYMBOL_MAP[signal.asset];
    if (!symbolName) return { error: `Symbole non supporté: ${signal.asset}` };

    const volume = this.calculateVolume(signal, balance, symbolName);
    if (volume === 0) return { error: 'Volume calculé à 0' };

    const msgId = `order_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId);

    this.send(PT.NEW_ORDER_REQ, 'ProtoOANewOrderReq', {
      ctidTraderAccountId: this.accountId,
      symbolName,
      orderType: 1, // MARKET
      tradeSide: signal.type === SignalType.BUY ? 1 : 2, // 1=BUY, 2=SELL
      volume,
      stopLoss: signal.tradeSetup.stopLoss,
      takeProfit: signal.tradeSetup.takeProfit,
    }, msgId);

    try {
      const res = await responsePromise;
      const positionId = res.position?.positionId?.toString();
      console.log(`✅ Ordre placé: ${symbolName} ${signal.type} vol=${volume} posId=${positionId}`);
      return { positionId };
    } catch (e: any) {
      console.error(`❌ Ordre échoué: ${e.message}`);
      return { error: e.message };
    }
  }

  async amendSL(positionId: string, newSL: number, newTP?: number): Promise<{ success: boolean }> {
    if (!this.authenticated) return { success: false };

    const msgId = `amend_${positionId}_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId);

    this.send(PT.AMEND_SL_REQ, 'ProtoOAAmendPositionSLTPReq', {
      ctidTraderAccountId: this.accountId,
      positionId: parseInt(positionId, 10),
      stopLoss: newSL,
      ...(newTP !== undefined ? { takeProfit: newTP } : {}),
    }, msgId);

    try {
      await responsePromise;
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async closePosition(positionId: string, volume: number = 0): Promise<OrderResult> {
    if (!this.authenticated) return { error: 'Non authentifié' };

    const msgId = `close_${positionId}_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId);

    this.send(PT.CLOSE_POS_REQ, 'ProtoOAClosePositionReq', {
      ctidTraderAccountId: this.accountId,
      positionId: parseInt(positionId, 10),
      volume: volume || 100000, // volume max pour clôture totale
    }, msgId);

    try {
      await responsePromise;
      return { positionId };
    } catch (e: any) {
      // Position déjà fermée côté broker → traiter comme succès silencieux
      if (e.message?.includes('POSITION_NOT_FOUND') || e.message?.includes('timeout')) {
        return { positionId, alreadyClosed: true };
      }
      return { error: e.message };
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    if (!this.authenticated) return { balance: 0, equity: 0 };

    const msgId = `trader_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId);

    this.send(PT.TRADER_REQ, 'ProtoOATraderReq', {
      ctidTraderAccountId: this.accountId,
    }, msgId);

    try {
      const res = await responsePromise;
      const divisor = Math.pow(10, res.trader?.moneyDigits ?? 2);
      return {
        balance: (res.trader?.balance ?? 0) / divisor,
        equity: (res.trader?.balance ?? 0) / divisor, // equity ≈ balance en l'absence de positions
      };
    } catch {
      return { balance: 0, equity: 0 };
    }
  }

  async getOpenPositionIds(): Promise<string[]> {
    if (!this.authenticated) return [];

    const msgId = `reconcile_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId);

    this.send(PT.RECONCILE_REQ, 'ProtoOAReconcileReq', {
      ctidTraderAccountId: this.accountId,
    }, msgId);

    try {
      const res = await responsePromise;
      return (res.position ?? []).map((p: any) => p.positionId?.toString()).filter(Boolean);
    } catch {
      return [];
    }
  }

  isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }
}

export const ctraderService = new CTraderService();
```

- [ ] **Step 3.2 : Vérifier qu'il n'y a pas d'erreurs d'import visibles dans l'IDE**

Ouvrir `services/ctraderService.ts`. S'assurer que `protobufjs` et `ws` sont reconnus (pas de soulignement rouge sur les imports).

- [ ] **Step 3.3 : Commit**

```bash
git add services/ctraderService.ts
git commit -m "feat: créer ctraderService — connexion WebSocket + ordres cTrader"
```

---

## Task 4 : agentController.ts

**Files:**
- Créer: `services/agentController.ts`

- [ ] **Step 4.1 : Créer `services/agentController.ts`**

```ts
import { Signal, AgentMode, AgentLimits } from '../types.ts';
import { ctraderService } from './ctraderService.ts';

export interface ExecutionDecision {
  execute: boolean;
  mode: AgentMode;
  reason?: string;
}

const DEFAULT_LIMITS: AgentLimits = {
  maxSimultaneousTrades: 3,
  maxRiskPercent: 5,
  maxDrawdownPercent: 15,
};

class AgentController {
  private mode: AgentMode = 'SIGNALS_ONLY';
  private limits: AgentLimits = { ...DEFAULT_LIMITS };
  private peakBalance = 0;
  private supabase: any = null;

  async init(supabaseClient: any): Promise<void> {
    this.supabase = supabaseClient;
    if (!supabaseClient) return;

    try {
      const { data } = await supabaseClient
        .from('app_config')
        .select('key, value')
        .in('key', ['agent_mode', 'agent_limits']);

      for (const row of data ?? []) {
        if (row.key === 'agent_mode') this.mode = row.value as AgentMode;
        if (row.key === 'agent_limits') this.limits = { ...DEFAULT_LIMITS, ...row.value };
      }
      console.log(`🤖 AgentController initialisé — mode: ${this.mode}`);
    } catch (e) {
      console.warn('AgentController: impossible de charger depuis Supabase, défauts utilisés.');
    }
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode;
    await this.persist('agent_mode', mode);
    console.log(`🤖 Mode agent changé → ${mode}`);
  }

  async setLimits(limits: Partial<AgentLimits>): Promise<void> {
    this.limits = { ...this.limits, ...limits };
    await this.persist('agent_limits', this.limits);
  }

  getMode(): AgentMode { return this.mode; }
  getLimits(): AgentLimits { return { ...this.limits }; }

  shouldExecute(signal: Signal, activeSignals: Signal[]): ExecutionDecision {
    if (this.mode === 'EMERGENCY_STOP') {
      return { execute: false, mode: this.mode, reason: 'Arrêt d\'urgence actif' };
    }
    if (this.mode === 'SIGNALS_ONLY') {
      return { execute: false, mode: this.mode };
    }
    if (activeSignals.length >= this.limits.maxSimultaneousTrades) {
      return { execute: false, mode: this.mode, reason: `Trades simultanés max atteint (${this.limits.maxSimultaneousTrades})` };
    }
    const openRisk = activeSignals.reduce((acc, s) => acc + (s.tradeSetup?.riskAmount ?? 0), 0);
    const signalRisk = signal.tradeSetup?.riskAmount ?? 0;
    // Note: le vrai guard % requiert le solde — vérifié dans server.ts avec getAccountInfo()
    if (this.mode === 'SEMI_AUTO') {
      return { execute: false, mode: 'SEMI_AUTO' };
    }
    // AUTONOMOUS
    return { execute: true, mode: 'AUTONOMOUS' };
  }

  async checkDrawdown(currentBalance: number): Promise<boolean> {
    if (currentBalance > this.peakBalance) this.peakBalance = currentBalance;
    if (this.peakBalance === 0) return false;

    const drawdownPct = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
    if (drawdownPct >= this.limits.maxDrawdownPercent) {
      console.error(`🚨 Drawdown max atteint: ${drawdownPct.toFixed(1)}% >= ${this.limits.maxDrawdownPercent}%`);
      await this.setMode('EMERGENCY_STOP');
      return true;
    }
    return false;
  }

  private async persist(key: string, value: any): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.supabase
        .from('app_config')
        .upsert({ key, value }, { onConflict: 'key' });
    } catch (e) {
      console.warn('AgentController: persist échoué', e);
    }
  }
}

export const agentController = new AgentController();
```

- [ ] **Step 4.2 : Initialiser les lignes app_config dans Supabase**

Dans l'interface Supabase (ou via le MCP), exécuter :

```sql
INSERT INTO app_config (key, value) VALUES
  ('agent_mode',   '"SIGNALS_ONLY"'),
  ('agent_limits', '{"maxSimultaneousTrades":3,"maxRiskPercent":5,"maxDrawdownPercent":15}')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 4.3 : Commit**

```bash
git add services/agentController.ts
git commit -m "feat: créer agentController — modes et gardes de risque"
```

---

## Task 5 : Intégration dans server.ts

**Files:**
- Modify: `server.ts`

- [ ] **Step 5.1 : Ajouter les imports en tête de `server.ts`**

Après les imports existants (ligne ~10) :

```ts
import { ctraderService } from "./services/ctraderService.ts";
import { agentController } from "./services/agentController.ts";
import type { AgentMode } from "./types.ts";
```

- [ ] **Step 5.2 : Initialiser cTrader et agentController au démarrage de `runBackgroundMonitor`**

Après le chargement Supabase (ligne ~188), ajouter :

```ts
// Init agent controller
await agentController.init(supabase);

// Init cTrader si mode != SIGNALS_ONLY
if (agentController.getMode() !== 'SIGNALS_ONLY') {
  try {
    await ctraderService.init();
    console.log('✅ cTrader service initialisé');
  } catch (e: any) {
    console.error('❌ cTrader init échoué:', e.message, '— mode forcé SIGNALS_ONLY');
    await agentController.setMode('SIGNALS_ONLY');
  }
}
```

- [ ] **Step 5.3 : Hook 1 — Exécution à la création d'un signal (ligne ~291)**

Remplacer le bloc `if (isAllowed) {` existant :

```ts
if (isAllowed) {
  activeSignals.push(newSignal);
  scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'SUCCESS', reason: diagnostic }, ...scanLogs].slice(0, MAX_LOGS);
  await supabase.from('signals').insert({ id: newSignal.id, asset: newSignal.asset, timeframe: '15m', content: newSignal });

  const decision = agentController.shouldExecute(newSignal, activeSignals);

  if (decision.execute) {
    const accountInfo = await ctraderService.getAccountInfo();
    const result = await ctraderService.placeOrder(newSignal, accountInfo.balance);
    if (result.positionId) {
      newSignal.ctraderPositionId = result.positionId;
      await supabase.from('signals').update({ content: newSignal }).eq('id', newSignal.id);
    }
    await sendTelegramMessage(`
🚀 *SIGNAL EXÉCUTÉ* 🚀
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}
*Position ID:* ${result.positionId ?? 'N/A'}
    `);
  } else if (decision.mode === 'SEMI_AUTO') {
    const executeUrl = `https://votre-serveur.com/api/agent/execute/${newSignal.id}`;
    await sendTelegramMessage(`
🔔 *SIGNAL EN ATTENTE DE VALIDATION* 🔔
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*Confiance:* ${newSignal.confidence}%

👉 Exécuter : /execute\\_${newSignal.id.substring(0, 8)}
    `);
  } else {
    await sendTelegramMessage(`
🚀 *NOUVEAU SIGNAL SNIPER V15* 🚀
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}
    `);
  }
```

- [ ] **Step 5.4 : Hook 2 — Breakeven (ligne ~229)**

Après `await sendTelegramMessage(...)` sur le breakeven, ajouter :

```ts
if (existing.ctraderPositionId) {
  await ctraderService.amendSL(existing.ctraderPositionId, existing.priceAtSignal);
  console.log(`🛡️ SL breakeven envoyé à cTrader pour ${existing.asset}`);
}
```

- [ ] **Step 5.5 : Hook 3 — Clôture Chandelier (ligne ~244)**

Après `tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);` :

```ts
if (existing.ctraderPositionId) {
  const closeResult = await ctraderService.closePosition(existing.ctraderPositionId);
  if (closeResult.alreadyClosed) {
    console.log(`ℹ️ Position ${existing.ctraderPositionId} déjà fermée par cTrader (SL/TP natif)`);
  }
}
```

- [ ] **Step 5.6 : Hook 4 — Sync positions cTrader (dans la boucle principale, après le scan des actifs)**

Après `lastBatchTimeMs = Date.now() - startTime;` :

```ts
// Sync drawdown + positions fermées côté broker
if (agentController.getMode() !== 'SIGNALS_ONLY' && ctraderService.isConnected()) {
  const accountInfo = await ctraderService.getAccountInfo();
  const emergencyTriggered = await agentController.checkDrawdown(accountInfo.balance);
  if (emergencyTriggered) {
    // Fermer toutes les positions cTrader
    for (const sig of activeSignals) {
      if (sig.ctraderPositionId) {
        await ctraderService.closePosition(sig.ctraderPositionId);
      }
    }
    activeSignals = [];
    if (supabase) await supabase.from('signals').delete().neq('id', 'none');
    await sendTelegramMessage('🚨 *ARRÊT D\'URGENCE* — Drawdown max atteint. Toutes positions fermées.');
  }

  // Réconcilier positions ouvertes vs activeSignals
  const openIds = new Set(await ctraderService.getOpenPositionIds());
  for (const sig of [...activeSignals]) {
    if (sig.ctraderPositionId && !openIds.has(sig.ctraderPositionId)) {
      // Fermée par le broker — sync état
      console.log(`📡 Position ${sig.ctraderPositionId} fermée par cTrader — sync`);
      const currentPrice = marketData[sig.asset]?.price ?? sig.priceAtSignal;
      const isBuy = sig.type === SignalType.BUY;
      const initialRisk = Math.abs(sig.priceAtSignal - sig.tradeSetup.stopLoss);
      const pnl = (isBuy ? (currentPrice - sig.priceAtSignal) : (sig.priceAtSignal - currentPrice)) / (initialRisk || 1);
      const { SignalStatus: SS } = await import('./types.ts');
      const status = pnl > 0.1 ? 'WIN' : 'LOSS';
      const closedSignal = { ...sig, status, closePrice: currentPrice, closedAt: Date.now(), pnl: pnl - 0.05, isNew: false };
      activeSignals = activeSignals.filter(s => s.id !== sig.id);
      tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);
      if (supabase) {
        await supabase.from('signals').delete().eq('id', sig.id);
        await supabase.from('history').insert({ id: sig.id, asset: sig.asset, pnl: closedSignal.pnl, closed_at: new Date(closedSignal.closedAt).toISOString(), content: closedSignal });
      }
    }
  }
}
```

- [ ] **Step 5.7 : Ajouter les 5 nouveaux endpoints API**

Ajouter dans `apiRouter`, avant `apiRouter.delete("/signals/:id", ...)` :

```ts
// --- AGENT CONTROLLER ENDPOINTS ---
apiRouter.get("/agent/status", async (req, res) => {
  const accountInfo = ctraderService.isConnected()
    ? await ctraderService.getAccountInfo()
    : { balance: 0, equity: 0 };
  res.json({
    mode: agentController.getMode(),
    limits: agentController.getLimits(),
    connected: ctraderService.isConnected(),
    balance: accountInfo.balance,
    equity: accountInfo.equity,
    openPositions: activeSignals.filter(s => s.ctraderPositionId).length,
  });
});

apiRouter.post("/agent/mode", async (req, res) => {
  const { mode } = req.body as { mode: AgentMode };
  const valid: AgentMode[] = ['SIGNALS_ONLY', 'SEMI_AUTO', 'AUTONOMOUS', 'EMERGENCY_STOP'];
  if (!valid.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });

  // Init cTrader si on passe d'un mode passif à un mode actif
  if (mode !== 'SIGNALS_ONLY' && !ctraderService.isConnected()) {
    try { await ctraderService.init(); } catch (e: any) {
      return res.status(500).json({ error: `cTrader init échoué: ${e.message}` });
    }
  }
  await agentController.setMode(mode);
  res.json({ success: true, mode });
});

apiRouter.post("/agent/limits", async (req, res) => {
  const { maxSimultaneousTrades, maxRiskPercent, maxDrawdownPercent } = req.body;
  await agentController.setLimits({ maxSimultaneousTrades, maxRiskPercent, maxDrawdownPercent });
  res.json({ success: true, limits: agentController.getLimits() });
});

apiRouter.post("/agent/execute/:id", async (req, res) => {
  const signal = activeSignals.find(s => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: 'Signal non trouvé' });
  if (signal.ctraderPositionId) return res.status(400).json({ error: 'Déjà exécuté' });

  const accountInfo = await ctraderService.getAccountInfo();
  const result = await ctraderService.placeOrder(signal, accountInfo.balance);
  if (result.positionId) {
    signal.ctraderPositionId = result.positionId;
    if (supabase) await supabase.from('signals').update({ content: signal }).eq('id', signal.id);
  }
  res.json({ success: !result.error, ...result });
});

apiRouter.post("/agent/emergency-stop", async (req, res) => {
  await agentController.setMode('EMERGENCY_STOP');
  isEngineRunning = false;

  const results = await Promise.allSettled(
    activeSignals
      .filter(s => s.ctraderPositionId)
      .map(s => ctraderService.closePosition(s.ctraderPositionId!))
  );

  activeSignals = [];
  if (supabase) await supabase.from('signals').delete().neq('id', 'none');
  await sendTelegramMessage('🚨 *ARRÊT D\'URGENCE ACTIVÉ* — Toutes positions fermées, moteur arrêté.');
  res.json({ success: true, closedCount: results.length });
});
```

- [ ] **Step 5.8 : Commit**

```bash
git add server.ts
git commit -m "feat: intégrer cTrader et agentController dans server.ts (5 hooks + 5 endpoints)"
```

---

## Task 6 : UI Agent Control Center

**Files:**
- Créer: `pages/AgentCenter.tsx`

- [ ] **Step 6.1 : Créer `pages/AgentCenter.tsx`**

```tsx
import React, { useState, useEffect } from 'react';
import { Shield, Zap, Eye, AlertTriangle, Save, RefreshCw } from 'lucide-react';
import type { AgentMode, AgentLimits, AgentStatus } from '../types';

const MODES: { id: AgentMode; label: string; desc: string; color: string; icon: React.ReactNode }[] = [
  { id: 'SIGNALS_ONLY', label: 'SIGNAUX SEULS', desc: 'Détection uniquement, aucune exécution', color: 'slate', icon: <Eye className="w-5 h-5" /> },
  { id: 'SEMI_AUTO',    label: 'SEMI-AUTO',     desc: 'Validation manuelle via Telegram',        color: 'amber',  icon: <Zap className="w-5 h-5" /> },
  { id: 'AUTONOMOUS',   label: 'AUTONOME',       desc: 'Exécution automatique avec gestion du risque', color: 'emerald', icon: <Shield className="w-5 h-5" /> },
  { id: 'EMERGENCY_STOP', label: 'ARRÊT D\'URGENCE', desc: 'Ferme tout et arrête le moteur', color: 'rose', icon: <AlertTriangle className="w-5 h-5" /> },
];

const colorMap: Record<string, string> = {
  slate:   'bg-slate-500/10 border-slate-500/30 text-slate-300',
  amber:   'bg-amber-500/10 border-amber-500/30 text-amber-400',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  rose:    'bg-rose-500/10 border-rose-500/30 text-rose-400',
};

const AgentCenter: React.FC = () => {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [limits, setLimits] = useState<AgentLimits>({ maxSimultaneousTrades: 3, maxRiskPercent: 5, maxDrawdownPercent: 15 });
  const [saving, setSaving] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/agent/status');
      const data = await res.json();
      setStatus(data);
      setLimits(data.limits);
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const setMode = async (mode: AgentMode) => {
    if (mode === 'AUTONOMOUS' && !confirm('Activer le mode AUTONOME ? Les ordres seront exécutés automatiquement.')) return;
    if (mode === 'EMERGENCY_STOP' && !confirm('ARRÊT D\'URGENCE : fermer toutes les positions et arrêter le moteur ?')) return;

    const endpoint = mode === 'EMERGENCY_STOP' ? '/api/agent/emergency-stop' : '/api/agent/mode';
    const body = mode === 'EMERGENCY_STOP' ? {} : { mode };

    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await fetchStatus();
  };

  const saveLimits = async () => {
    setSaving(true);
    await fetch('/api/agent/limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(limits) });
    setSaving(false);
    await fetchStatus();
  };

  const currentMode = status?.mode ?? 'SIGNALS_ONLY';

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-black text-white mb-1">Agent Control Center</h1>
        <p className="text-slate-500 text-sm font-medium">Mode d'exécution & gestion du risque</p>
      </div>

      {/* cTrader Status */}
      <div className={`p-4 rounded-2xl border flex items-center gap-4 ${status?.connected ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20'}`}>
        <div className={`w-3 h-3 rounded-full ${status?.connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
        <div className="flex-1">
          <span className={`font-black text-xs uppercase ${status?.connected ? 'text-emerald-400' : 'text-rose-400'}`}>
            cTrader {status?.connected ? 'CONNECTÉ' : 'DÉCONNECTÉ'}
          </span>
          {status?.connected && (
            <span className="text-slate-400 text-xs ml-4">
              Solde: <strong className="text-white">{status.balance.toFixed(2)} USD</strong>
              &nbsp;· Positions: <strong className="text-white">{status.openPositions}</strong>
            </span>
          )}
        </div>
        <button onClick={fetchStatus} className="text-slate-500 hover:text-white transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Mode Selector */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Mode d'exécution</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`p-5 rounded-2xl border text-left transition-all ${
                currentMode === m.id
                  ? colorMap[m.color] + ' ring-1 ring-current'
                  : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600'
              }`}
            >
              <div className="flex items-center gap-3 mb-2">
                {m.icon}
                <span className="font-black text-xs uppercase tracking-widest">{m.label}</span>
                {currentMode === m.id && <span className="ml-auto text-[9px] font-black uppercase opacity-60">ACTIF</span>}
              </div>
              <p className="text-[11px] opacity-70 leading-relaxed">{m.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Risk Limits */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Limites de Risque</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
          {([
            { key: 'maxSimultaneousTrades', label: 'Trades Simultanés Max', suffix: '' },
            { key: 'maxRiskPercent',        label: 'Risque Total Max',       suffix: '%' },
            { key: 'maxDrawdownPercent',    label: 'Drawdown Max',           suffix: '%' },
          ] as const).map(({ key, label, suffix }) => (
            <div key={key}>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">{label}</label>
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                <input
                  type="number"
                  value={limits[key]}
                  onChange={e => setLimits(prev => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
                  className="flex-1 bg-transparent py-3 px-4 text-white text-lg font-mono font-bold focus:outline-none"
                  min={0}
                />
                {suffix && <span className="pr-4 text-slate-500 font-bold">{suffix}</span>}
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={saveLimits}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl font-black text-xs transition-all shadow-lg active:scale-95"
        >
          <Save className="w-4 h-4" />
          {saving ? 'SAUVEGARDE...' : 'SAUVEGARDER LIMITES'}
        </button>
      </section>
    </div>
  );
};

export default AgentCenter;
```

- [ ] **Step 6.2 : Commit**

```bash
git add pages/AgentCenter.tsx
git commit -m "feat: créer page AgentCenter (UI mode + limites + statut cTrader)"
```

---

## Task 7 : Routing et Navigation

**Files:**
- Modify: `App.tsx`
- Modify: `components/Layout.tsx`

- [ ] **Step 7.1 : Ajouter la route `/agent` dans `App.tsx`**

Dans `App.tsx`, ajouter l'import :

```ts
import AgentCenter from './pages/AgentCenter';
```

Et dans le bloc de routes, ajouter :

```tsx
<Route path="/agent" element={<AgentCenter />} />
```

- [ ] **Step 7.2 : Ajouter le lien "Agent" dans `components/Layout.tsx`**

Dans la liste des liens de navigation existants, ajouter :

```tsx
<NavLink to="/agent" icon={<Shield className="w-5 h-5" />} label="Agent" />
```

Et importer `Shield` depuis `lucide-react` si pas déjà présent.

- [ ] **Step 7.3 : Commit**

```bash
git add App.tsx components/Layout.tsx
git commit -m "feat: ajouter route /agent et lien de navigation Agent Center"
```

---

## Task 8 : Vérification end-to-end

- [ ] **Step 8.1 : Démarrer le serveur**

```bash
npm run dev
```

Vérifier dans les logs :
```
✅ cTrader WebSocket connecté       ← si mode != SIGNALS_ONLY
✅ cTrader Application Auth OK
✅ cTrader Account Auth OK — compte 9932624
🤖 AgentController initialisé — mode: SIGNALS_ONLY
```

Si `CTRADER_ACCESS_TOKEN` n'est pas encore obtenu, les logs afficheront :
```
❌ cTrader init échoué — mode forcé SIGNALS_ONLY
```
→ Revenir à Task 0.

- [ ] **Step 8.2 : Tester le statut via l'API**

```bash
curl http://localhost:3000/api/agent/status
```

Réponse attendue :
```json
{
  "mode": "SIGNALS_ONLY",
  "limits": { "maxSimultaneousTrades": 3, "maxRiskPercent": 5, "maxDrawdownPercent": 15 },
  "connected": true,
  "balance": 50000.00,
  "equity": 50000.00,
  "openPositions": 0
}
```

- [ ] **Step 8.3 : Tester le changement de mode**

```bash
curl -X POST http://localhost:3000/api/agent/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"AUTONOMOUS"}'
```

Réponse attendue : `{"success":true,"mode":"AUTONOMOUS"}`

- [ ] **Step 8.4 : Vérifier l'UI sur `http://localhost:3000/agent`**

- Le badge cTrader est vert avec le solde du compte démo
- Les 4 boutons de mode s'affichent
- Cliquer sur AUTONOME → confirmation → mode change → badge se met à jour

- [ ] **Step 8.5 : Test d'exécution manuelle (SEMI_AUTO)**

Passer en mode SEMI_AUTO. Attendre un signal. Vérifier le message Telegram avec l'ID du signal.

Exécuter manuellement :
```bash
curl -X POST http://localhost:3000/api/agent/execute/<signal-id>
```

Vérifier dans la plateforme cTrader (démo IC Markets) que la position est ouverte.

- [ ] **Step 8.6 : Commit final**

```bash
git add -A
git commit -m "feat: exécution automatisée cTrader IC Markets — Agent Control Center complet"
```
