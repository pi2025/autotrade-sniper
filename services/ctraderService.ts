import tls from 'tls';
import protobuf from 'protobufjs';
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

const RESPONSE_MESSAGE_TYPES: Partial<Record<number, string>> = {
  [PT.APP_AUTH_RES]: 'ProtoOAApplicationAuthRes',
  [PT.ACC_AUTH_RES]: 'ProtoOAAccountAuthRes',
  [PT.EXECUTION_EVT]: 'ProtoOAExecutionEvent',
  [PT.RECONCILE_RES]: 'ProtoOAReconcileRes',
  [PT.TRADER_RES]: 'ProtoOATraderRes',
};

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
  private socket: tls.TLSSocket | null = null;
  private proto: protobuf.Root | null = null;
  private buffer = Buffer.alloc(0);
  private pendingCallbacks = new Map<string, (msg: any) => void>();
  private pendingByPayloadType = new Map<number, (msg: any) => void>();
  private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private authenticated = false;

  private get tlsHost() {
    return process.env.CTRADER_LIVE === 'true'
      ? 'live.ctraderapi.com'
      : 'demo.ctraderapi.com'; // port 5035 = plain TCP, port 5036 = TLS
  }

  private get accountId(): number {
    return parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
  }

  async init(): Promise<void> {
    this.proto = await protobuf.load(path.join(__dirname, 'ctrader.proto'));
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.buffer = Buffer.alloc(0);

      // Port 5036 = TLS (both demo and live)
      this.socket = tls.connect({ host: this.tlsHost, port: 5036, rejectUnauthorized: false });

      this.socket.on('secureConnect', async () => {
        console.log(`✅ cTrader TLS connecté à ${this.tlsHost}:5036`);
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

      this.socket.on('data', (chunk: Buffer) => {
        console.log(`📥 cTrader raw data (${chunk.length}B): ${chunk.slice(0, 32).toString('hex')}`);
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      });

      this.socket.on('close', () => {
        console.warn('⚠️ cTrader déconnecté. Reconnexion dans', this.reconnectDelay, 'ms');
        this.authenticated = false;
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
          this.connect().catch(console.error);
        }, this.reconnectDelay);
      });

      this.socket.on('error', (err) => {
        console.error('❌ cTrader socket error:', err.message);
        reject(err);
      });
    });
  }

  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      this.handleMessage(payload);
    }
  }

  private handleMessage(payload: Buffer): void {
    if (!this.proto) return;
    try {
      const ProtoMessage = this.proto.lookupType('ProtoMessage');
      const outerMsg: any = ProtoMessage.decode(payload);
      const messageType = RESPONSE_MESSAGE_TYPES[outerMsg.payloadType];
      const innerMsg = messageType && outerMsg.payload
        ? this.proto.lookupType(messageType).decode(outerMsg.payload)
        : {};
      const msg: any = {
        ...(innerMsg as object),
        payloadType: outerMsg.payloadType,
        clientMsgId: outerMsg.clientMsgId,
      };

      console.log(`📨 cTrader ← payloadType=${msg.payloadType} clientMsgId=${msg.clientMsgId ?? '—'}`);

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
    } catch (e) {
      console.error('cTrader message parse error:', e);
    }
  }

  private send(payloadType: number, messageType: string, fields: object, clientMsgId?: string): void {
    if (!this.proto || !this.socket || this.socket.destroyed) return;

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
    Buffer.from(outerBytes).copy(buf, 4);
    console.log(`📤 cTrader → payloadType=${payloadType} len=${outerBytes.length} hex=${buf.slice(0, 32).toString('hex')}`);
    this.socket.write(buf);
  }

  private waitForResponse(clientMsgId: string, expectedPayloadType?: number, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(clientMsgId);
        if (expectedPayloadType) this.pendingByPayloadType.delete(expectedPayloadType);
        reject(new Error(`cTrader timeout: ${clientMsgId}`));
      }, timeoutMs);

      const handler = (msg: any) => {
        clearTimeout(timer);
        this.pendingCallbacks.delete(clientMsgId);
        if (expectedPayloadType) this.pendingByPayloadType.delete(expectedPayloadType);
        resolve(msg);
      };

      this.pendingCallbacks.set(clientMsgId, handler);
      if (expectedPayloadType) this.pendingByPayloadType.set(expectedPayloadType, handler);
    });
  }

  private async applicationAuth(): Promise<void> {
    const msgId = 'app_auth';
    const responsePromise = this.waitForResponse(msgId, PT.APP_AUTH_RES);
    this.send(PT.APP_AUTH_REQ, 'ProtoOAApplicationAuthReq', {
      clientId: process.env.CTRADER_CLIENT_ID!,
      clientSecret: process.env.CTRADER_CLIENT_SECRET!,
    }, msgId);
    await responsePromise;
    console.log('✅ cTrader Application Auth OK');
  }

  private async accountAuth(): Promise<void> {
    const msgId = 'acc_auth';
    const responsePromise = this.waitForResponse(msgId, PT.ACC_AUTH_RES);
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
    const riskAmount = balance * (0.01 * riskMultiplier);
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

    const apiVolume = isDiscrete
      ? Math.floor(baseUnits)
      : Math.round(baseUnits / 1000);

    return Math.max(1, Math.min(apiVolume, 100));
  }

  async placeOrder(signal: Signal, balance: number): Promise<OrderResult> {
    if (!this.authenticated) return { error: 'cTrader non authentifié' };

    const symbolName = SYMBOL_MAP[signal.asset];
    if (!symbolName) return { error: `Symbole non supporté: ${signal.asset}` };

    const volume = this.calculateVolume(signal, balance, symbolName);
    if (volume === 0) return { error: 'Volume calculé à 0' };

    const msgId = `order_${Date.now()}`;
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);

    this.send(PT.NEW_ORDER_REQ, 'ProtoOANewOrderReq', {
      ctidTraderAccountId: this.accountId,
      symbolName,
      orderType: 1,
      tradeSide: signal.type === SignalType.BUY ? 1 : 2,
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
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);

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
    const responsePromise = this.waitForResponse(msgId, PT.EXECUTION_EVT);

    this.send(PT.CLOSE_POS_REQ, 'ProtoOAClosePositionReq', {
      ctidTraderAccountId: this.accountId,
      positionId: parseInt(positionId, 10),
      volume: volume || 100000,
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
    const responsePromise = this.waitForResponse(msgId, PT.RECONCILE_RES);

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
    return this.authenticated && !!this.socket && !this.socket.destroyed;
  }
}

export const ctraderService = new CTraderService();
