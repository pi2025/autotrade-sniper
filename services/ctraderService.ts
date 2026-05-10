import tls from 'tls';
import { Signal, SignalType, AssetType, AgentPositionSizing } from '../types.ts';
import { DEFAULT_POSITION_SIZING } from './agentController.ts';

const PT = {
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACC_AUTH_REQ: 2102,
  ACC_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  AMEND_SL_REQ: 2109,
  CLOSE_POS_REQ: 2111,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVT: 2126,
  ERROR_RES: 2142,
  ACCOUNT_LIST_REQ: 2149,
  ACCOUNT_LIST_RES: 2150,
} as const;

const SYMBOL_MAP: Record<string, string> = {
  'EURUSD=X': 'EURUSD', 'GBPUSD=X': 'GBPUSD', 'USDJPY=X': 'USDJPY',
  'AUDUSD=X': 'AUDUSD', 'USDCAD=X': 'USDCAD', 'USDCHF=X': 'USDCHF',
  'NZDUSD=X': 'NZDUSD', 'EURGBP=X': 'EURGBP', 'EURJPY=X': 'EURJPY',
  'GBPJPY=X': 'GBPJPY', 'AUDJPY=X': 'AUDJPY', 'CHFJPY=X': 'CHFJPY',
  'EURNZD=X': 'EURNZD', 'GBPAUD=X': 'GBPAUD', 'CADJPY=X': 'CADJPY',
  'EURCHF=X': 'EURCHF', 'EURAUD=X': 'EURAUD',
  'GC=F': 'XAUUSD', 'SI=F': 'XAGUSD', 'CL=F': 'USOIL',
  'BTC-USD': 'BTCUSD', 'ETH-USD': 'ETHUSD', 'SOL-USD': 'SOLUSD',
  'BNB-USD': 'BNBUSD', 'XRP-USD': 'XRPUSD',
  '^GSPC': 'SP500', '^IXIC': 'NAS100', '^FCHI': 'FRA40',
};

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

interface JsonMessage {
  payloadType: number;
  clientMsgId?: string;
  payload?: any;
}

class CTraderService {
  private socket: tls.TLSSocket | null = null;
  private pendingCallbacks = new Map<string, (msg: JsonMessage) => void>();
  private pendingByPayloadType = new Map<number, (msg: JsonMessage) => void>();
  private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private authenticated = false;
  private receiveBuffer = '';
  private symbolIds = new Map<string, number>();

  private get tlsHost() {
    return process.env.CTRADER_LIVE === 'true'
      ? 'live.ctraderapi.com'
      : 'demo.ctraderapi.com';
  }

  private get accountId(): number {
    return parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
  }

  async init(): Promise<void> {
    if (this.authenticated && this.socket && !this.socket.destroyed) return;
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.receiveBuffer = '';
      this.socket = tls.connect({ host: this.tlsHost, port: 5036, rejectUnauthorized: false });

      const failOnce = (err: any) => {
        this.socket?.removeListener('error', failOnce);
        reject(err);
      };

      this.socket.on('secureConnect', async () => {
        console.log(`✅ cTrader JSON/TLS connecté à ${this.tlsHost}:5036`);
        this.reconnectDelay = 1000;
        this.socket?.removeListener('error', failOnce);
        try {
          await this.applicationAuth();
          await this.accountAuth();
          await this.loadSymbols();
          this.startHeartbeat();
          this.authenticated = true;
          resolve();
        } catch (e) {
          this.socket?.destroy();
          reject(e);
        }
      });

      this.socket.on('data', (chunk: Buffer) => this.handleData(chunk.toString('utf8')));

      this.socket.on('close', () => {
        const shouldReconnect = this.authenticated;
        this.authenticated = false;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        if (!shouldReconnect) return;

        console.warn('⚠️ cTrader déconnecté. Reconnexion dans', this.reconnectDelay, 'ms');
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          this.connect().catch(console.error);
        }, this.reconnectDelay);
      });

      this.socket.on('error', failOnce);
      this.socket.on('error', (err) => {
        console.error('❌ cTrader socket error:', err.message);
      });
    });
  }

  private handleData(text: string): void {
    this.receiveBuffer += text;

    while (this.receiveBuffer.trimStart().startsWith('{')) {
      const parsed = this.extractJsonObject(this.receiveBuffer);
      if (!parsed) return;
      this.receiveBuffer = parsed.rest;
      this.handleMessage(parsed.message);
    }
  }

  private extractJsonObject(input: string): { message: JsonMessage; rest: string } | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = input.search(/\S/);
    if (start < 0) return null;

    for (let i = start; i < input.length; i++) {
      const char = input[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return {
            message: JSON.parse(input.slice(start, i + 1)),
            rest: input.slice(i + 1),
          };
        }
      }
    }
    return null;
  }

  private handleMessage(msg: JsonMessage): void {
    console.log(`📨 cTrader ← payloadType=${msg.payloadType} clientMsgId=${msg.clientMsgId ?? '-'}`);

    const clientMsgId = msg.clientMsgId;
    if (clientMsgId && this.pendingCallbacks.has(clientMsgId)) {
      const cb = this.pendingCallbacks.get(clientMsgId)!;
      this.pendingCallbacks.delete(clientMsgId);
      cb(msg);
      return;
    }

    if (this.pendingByPayloadType.has(msg.payloadType)) {
      const cb = this.pendingByPayloadType.get(msg.payloadType)!;
      this.pendingByPayloadType.delete(msg.payloadType);
      cb(msg);
    }
  }

  private send(payloadType: number, payload: object, clientMsgId?: string): void {
    if (!this.socket || this.socket.destroyed) throw new Error('cTrader socket non connecté');

    const msg = JSON.stringify({
      payloadType,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(Object.keys(payload).length ? { payload } : {}),
    });
    console.log(`📤 cTrader → payloadType=${payloadType} clientMsgId=${clientMsgId ?? '-'}`);
    this.socket.write(msg);
  }

  private waitForResponse(clientMsgId: string, expectedPayloadType?: number, timeoutMs = 8000): Promise<JsonMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(clientMsgId);
        if (expectedPayloadType) this.pendingByPayloadType.delete(expectedPayloadType);
        reject(new Error(`cTrader timeout: ${clientMsgId}`));
      }, timeoutMs);

      const handler = (msg: JsonMessage) => {
        clearTimeout(timer);
        this.pendingCallbacks.delete(clientMsgId);
        if (expectedPayloadType) this.pendingByPayloadType.delete(expectedPayloadType);

        if (msg.payloadType === PT.ERROR_RES) {
          const code = msg.payload?.errorCode ?? 'UNKNOWN_ERROR';
          const description = msg.payload?.description ? `: ${msg.payload.description}` : '';
          reject(new Error(`${code}${description}`));
          return;
        }
        resolve(msg);
      };

      this.pendingCallbacks.set(clientMsgId, handler);
      if (expectedPayloadType) this.pendingByPayloadType.set(expectedPayloadType, handler);
    });
  }

  private async applicationAuth(): Promise<void> {
    const msgId = 'app_auth';
    const responsePromise = this.waitForResponse(msgId, PT.APP_AUTH_RES);
    this.send(PT.APP_AUTH_REQ, {
      clientId: process.env.CTRADER_CLIENT_ID,
      clientSecret: process.env.CTRADER_CLIENT_SECRET,
    }, msgId);
    await responsePromise;
    console.log('✅ cTrader Application Auth OK');
  }

  private async accountAuth(): Promise<void> {
    const msgId = 'acc_auth';
    const responsePromise = this.waitForResponse(msgId, PT.ACC_AUTH_RES);
    this.send(PT.ACC_AUTH_REQ, {
      accessToken: process.env.CTRADER_ACCESS_TOKEN,
      ctidTraderAccountId: this.accountId,
    }, msgId);
    await responsePromise;
    console.log(`✅ cTrader Account Auth OK — compte ${this.accountId}`);
  }

  private async loadSymbols(): Promise<void> {
    const msgId = `symbols_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId, PT.SYMBOLS_LIST_RES);
    this.send(PT.SYMBOLS_LIST_REQ, {
      ctidTraderAccountId: this.accountId,
      includeArchivedSymbols: false,
    }, msgId);

    const res = await responsePromise;
    const symbols = res.payload?.symbol ?? res.payload?.lightSymbol ?? [];
    this.symbolIds.clear();
    for (const symbol of symbols) {
      if (symbol.symbolName && symbol.symbolId) {
        this.symbolIds.set(symbol.symbolName, Number(symbol.symbolId));
      }
    }
    console.log(`✅ cTrader symboles chargés: ${this.symbolIds.size}`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      try {
        this.send(PT.HEARTBEAT, {});
      } catch (e) {
        console.error('Heartbeat cTrader échoué:', e);
      }
    }, 10000);
  }

  private getAssetMultiplier(signal: Signal, sizing: AgentPositionSizing): number {
    if (signal.assetType === AssetType.FOREX) return sizing.forexMultiplier;
    if (signal.assetType === AssetType.CRYPTO) return sizing.cryptoMultiplier;
    if (signal.assetType === AssetType.COMMODITY) return sizing.commodityMultiplier;
    if (signal.assetType === AssetType.INDEX) return sizing.indexMultiplier;
    if (signal.assetType === AssetType.STOCK) return sizing.stockMultiplier;
    return 1;
  }

  private calculateRiskAmount(signal: Signal, balance: number, sizing: AgentPositionSizing): number {
    const multiplier = Math.max(0, sizing.multiplier) * Math.max(0, this.getAssetMultiplier(signal, sizing));
    if (sizing.mode === 'FIXED_AMOUNT') return Math.max(0, sizing.fixedAmount) * multiplier;
    if (sizing.mode === 'FIXED_LOT') return 0;
    return balance * (Math.max(0, sizing.riskPercent) / 100) * multiplier;
  }

  private calculateVolume(signal: Signal, balance: number, symbolName: string, rawSizing?: Partial<AgentPositionSizing>): number {
    const sizing: AgentPositionSizing = { ...DEFAULT_POSITION_SIZING, ...(rawSizing ?? {}) };

    if (sizing.mode === 'FIXED_LOT') {
      const lots = Math.max(0, sizing.fixedLot)
        * Math.max(0, sizing.multiplier)
        * Math.max(0, this.getAssetMultiplier(signal, sizing));
      const units = lots * 100000;
      const boundedUnits = Math.max(sizing.minVolumeUnits, Math.min(units, sizing.maxVolumeUnits));
      return Math.round(boundedUnits * 100);
    }

    const riskAmount = this.calculateRiskAmount(signal, balance, sizing);
    const slDistance = Math.abs(signal.priceAtSignal - signal.tradeSetup.stopLoss);
    if (slDistance === 0) return 0;

    let baseUnits: number;
    if (USD_BASE.has(symbolName)) {
      baseUnits = (riskAmount * signal.priceAtSignal) / slDistance;
    } else {
      baseUnits = riskAmount / slDistance;
    }

    const boundedUnits = Math.max(sizing.minVolumeUnits, Math.min(baseUnits, sizing.maxVolumeUnits));
    return Math.round(boundedUnits * 100);
  }

  async placeOrder(signal: Signal, balance: number, positionSizing?: Partial<AgentPositionSizing>): Promise<OrderResult> {
    if (!this.authenticated) return { error: 'cTrader non authentifié' };

    const symbolName = SYMBOL_MAP[signal.asset];
    if (!symbolName) return { error: `Symbole non supporté: ${signal.asset}` };

    const symbolId = this.symbolIds.get(symbolName);
    if (!symbolId) return { error: `SymbolId introuvable pour ${symbolName}` };

    const volume = this.calculateVolume(signal, balance, symbolName, positionSizing);
    if (volume === 0) return { error: 'Volume calculé à 0' };

    const msgId = `order_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);

    this.send(PT.NEW_ORDER_REQ, {
      ctidTraderAccountId: this.accountId,
      symbolId,
      orderType: 1,
      tradeSide: signal.type === SignalType.BUY ? 1 : 2,
      volume,
      stopLoss: signal.tradeSetup.stopLoss,
      takeProfit: signal.tradeSetup.takeProfit,
    }, msgId);

    try {
      const res = await responsePromise;
      const positionId = res.payload?.position?.positionId?.toString();
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
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);
    this.send(PT.AMEND_SL_REQ, {
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
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);
    this.send(PT.CLOSE_POS_REQ, {
      ctidTraderAccountId: this.accountId,
      positionId: parseInt(positionId, 10),
      volume: volume || 10_000_000,
    }, msgId);

    try {
      await responsePromise;
      return { positionId };
    } catch (e: any) {
      if (e.message?.includes('POSITION_NOT_FOUND') || e.message?.includes('timeout')) {
        return { positionId, alreadyClosed: true };
      }
      return { error: e.message };
    }
  }

  async getAccountInfo(): Promise<AccountInfo> {
    if (!this.authenticated) return { balance: 0, equity: 0 };

    const msgId = `trader_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId, PT.TRADER_RES);
    this.send(PT.TRADER_REQ, { ctidTraderAccountId: this.accountId }, msgId);

    try {
      const res = await responsePromise;
      const trader = res.payload?.trader ?? {};
      const divisor = Math.pow(10, trader.moneyDigits ?? 2);
      const balance = (trader.balance ?? 0) / divisor;
      return { balance, equity: balance };
    } catch {
      return { balance: 0, equity: 0 };
    }
  }

  async getOpenPositionIds(): Promise<string[]> {
    if (!this.authenticated) return [];

    const msgId = `reconcile_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId, PT.RECONCILE_RES);
    this.send(PT.RECONCILE_REQ, { ctidTraderAccountId: this.accountId }, msgId);

    try {
      const res = await responsePromise;
      return (res.payload?.position ?? []).map((p: any) => p.positionId?.toString()).filter(Boolean);
    } catch {
      return [];
    }
  }

  isConnected(): boolean {
    return this.authenticated && !!this.socket && !this.socket.destroyed;
  }
}

export const ctraderService = new CTraderService();
