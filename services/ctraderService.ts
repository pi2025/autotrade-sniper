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

  private calculateVolume(signal: Signal, balance: number, symbolName: string): number {
    const riskMultiplier = (symbolName === 'EURUSD') ? 0.5 : 1;
    const riskAmount = balance * (0.01 * riskMultiplier); // 1% × multiplier
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

    // FX: 1 API unit = 1000 base units → diviser par 1000
    // Indices/Commodités: 1 API unit = 1 unité → arrondir à l'entier
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
        equity: (res.trader?.balance ?? 0) / divisor,
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
