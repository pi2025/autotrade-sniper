
import fetch from 'node-fetch';
import { Signal, AssetType, SignalType } from '../types.ts';

// --- CONFIGURATION ---
const OANDA_API_KEY   = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const IS_LIVE         = process.env.OANDA_LIVE === 'true';
const RISK_PERCENT    = parseFloat(process.env.OANDA_RISK_PERCENT || '1') / 100; // défaut 1%

const BASE_URL = IS_LIVE
  ? 'https://api-oanda.com/v3'
  : 'https://api-fxpractice.oanda.com/v3';

// --- MAPPING Yahoo Finance → Instrument OANDA ---
const INSTRUMENT_MAP: Record<string, string> = {
  'EURUSD=X': 'EUR_USD',
  'GBPUSD=X': 'GBP_USD',
  'USDJPY=X': 'USD_JPY',
  'AUDUSD=X': 'AUD_USD',
  'USDCAD=X': 'USD_CAD',
  'USDCHF=X': 'USD_CHF',
  'NZDUSD=X': 'NZD_USD',
  'EURGBP=X': 'EUR_GBP',
  'EURJPY=X': 'EUR_JPY',
  'GBPJPY=X': 'GBP_JPY',
  'GC=F':     'XAU_USD',
  'SI=F':     'XAG_USD',
  'CL=F':     'WTICO_USD',
  '^GSPC':    'SPX500_USD',
  '^IXIC':    'NAS100_USD',
  '^FCHI':    'FR40_EUR',
};

// --- TYPES INTERNES ---
export interface OandaConnectionStatus {
  connected: boolean;
  mode: 'DEMO' | 'LIVE';
  accountId: string | null;
  balance?: number;
  currency?: string;
  error?: string;
}

export interface OandaOrderResult {
  success: boolean;
  tradeId?: string;
  instrument?: string;
  units?: number;
  error?: string;
}

export interface OandaOpenTrade {
  tradeId: string;
  instrument: string;
  units: number;
  openPrice: number;
  unrealizedPnl: number;
  openedAt: string;
}

// --- HELPERS ---
function oandaHeaders() {
  return {
    'Authorization': `Bearer ${OANDA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Convertit un symbole Yahoo en instrument OANDA.
 * Retourne null si le symbole n'est pas supporté.
 */
function toInstrument(yahooSymbol: string): string | null {
  return INSTRUMENT_MAP[yahooSymbol] ?? null;
}

/**
 * Calcule le nombre d'unités OANDA à ouvrir pour respecter le risque cible.
 *
 * Règles par type d'actif :
 *   - Forex USD-quoté (EUR/USD, GBP/USD, AUD/USD, XAU/USD...) :
 *       units = riskAmount / slDistance
 *       (1 unit bouge de 1 USD par unité de prix, valeur direct en USD)
 *
 *   - Forex USD-base (USD/JPY, USD/CAD, USD/CHF) :
 *       La valeur d'un pip en USD dépend du cours : valeur = 1 / price
 *       units = (riskAmount * price) / slDistance
 *
 *   - Indices CFD (SPX500_USD, NAS100_USD) :
 *       Même logique que USD-quoté (1 unit = 1 USD par point)
 *       units = riskAmount / slDistance  → arrondi à l'entier
 *
 *   - Crosses EUR/GBP, EUR/JPY, GBP/JPY :
 *       Approximation USD-quoté acceptable en demo.
 *       Une conversion précise nécessiterait le cours spot croisé en temps réel.
 *
 * Plafond de sécurité : jamais plus de 100 000 units (1 lot standard) par trade.
 */
function calculateUnits(
  signal: Signal,
  balance: number,
  instrument: string
): number {
  const riskAmount  = balance * RISK_PERCENT;
  const slDistance  = Math.abs(signal.priceAtSignal - signal.tradeSetup.stopLoss);

  if (slDistance === 0) return 0;

  const isUsdBase = ['USD_JPY', 'USD_CAD', 'USD_CHF'].includes(instrument);

  let rawUnits: number;
  if (isUsdBase) {
    // Pour USD/JPY : SL en JPY, valeur par unit en USD = 1/price
    rawUnits = (riskAmount * signal.priceAtSignal) / slDistance;
  } else {
    // EUR/USD, GBP/USD, XAU/USD, Indices, Matières premières
    rawUnits = riskAmount / slDistance;
  }

  // Pour les indices et matières premières on arrondit à l'entier
  const isIntegerUnit = signal.assetType === AssetType.INDEX
    || signal.assetType === AssetType.COMMODITY
    || signal.assetType === AssetType.STOCK;

  const units = isIntegerUnit
    ? Math.floor(rawUnits)
    : Math.round(rawUnits);

  // Plafond de sécurité : 1 lot standard max
  const MAX_UNITS = 100_000;
  return Math.min(units, MAX_UNITS);
}

// --- FONCTIONS PUBLIQUES ---

/**
 * Vérifie que les credentials OANDA sont valides et retourne le statut complet.
 */
export async function testConnection(): Promise<OandaConnectionStatus> {
  if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
    return {
      connected: false,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: OANDA_ACCOUNT_ID ?? null,
      error: 'OANDA_API_KEY ou OANDA_ACCOUNT_ID manquant dans les variables d\'environnement.',
    };
  }

  try {
    const response = await fetch(
      `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/summary`,
      { headers: oandaHeaders() }
    );

    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      return {
        connected: false,
        mode: IS_LIVE ? 'LIVE' : 'DEMO',
        accountId: OANDA_ACCOUNT_ID,
        error: body.errorMessage || `HTTP ${response.status}`,
      };
    }

    const data: any = await response.json();
    const account = data.account;

    return {
      connected: true,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: OANDA_ACCOUNT_ID,
      balance: parseFloat(account.balance),
      currency: account.currency,
    };
  } catch (err: any) {
    return {
      connected: false,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: OANDA_ACCOUNT_ID,
      error: err.message,
    };
  }
}

/**
 * Retourne le solde actuel du compte en devise de base.
 */
export async function getAccountBalance(): Promise<{ balance: number; currency: string } | null> {
  if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) return null;

  try {
    const response = await fetch(
      `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/summary`,
      { headers: oandaHeaders() }
    );
    if (!response.ok) return null;

    const data: any = await response.json();
    return {
      balance: parseFloat(data.account.balance),
      currency: data.account.currency,
    };
  } catch {
    return null;
  }
}

/**
 * Ouvre un trade sur OANDA à partir d'un Signal V15.
 * - Calcule automatiquement la taille de position (1% de risque par défaut).
 * - Place un Market Order avec TP et SL attachés.
 * - Retourne null si l'instrument n'est pas supporté par OANDA.
 */
export async function placeOrder(signal: Signal): Promise<OandaOrderResult> {
  if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
    return { success: false, error: 'Credentials OANDA non configurés.' };
  }

  const instrument = toInstrument(signal.asset);
  if (!instrument) {
    return { success: false, error: `Instrument non supporté sur OANDA: ${signal.asset}` };
  }

  const account = await getAccountBalance();
  if (!account) {
    return { success: false, error: 'Impossible de récupérer le solde du compte.' };
  }

  const rawUnits = calculateUnits(signal, account.balance, instrument);
  if (rawUnits === 0) {
    return { success: false, error: 'Taille de position calculée à 0 (SL trop proche ou solde insuffisant).' };
  }

  // OANDA : unités négatives = SELL, positives = BUY
  const units = signal.type === SignalType.BUY ? rawUnits : -rawUnits;
  const tp = signal.tradeSetup.takeProfit.toFixed(5);
  const sl = signal.tradeSetup.stopLoss.toFixed(5);

  const orderBody = {
    order: {
      type: 'MARKET',
      instrument,
      units: units.toString(),
      takeProfitOnFill: { price: tp },
      stopLossOnFill:   { price: sl, timeInForce: 'GTC' },
      timeInForce: 'FOK', // Fill Or Kill — pas de partial fill
    },
  };

  try {
    const response = await fetch(
      `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/orders`,
      {
        method: 'POST',
        headers: oandaHeaders(),
        body: JSON.stringify(orderBody),
      }
    );

    const data: any = await response.json();

    if (!response.ok) {
      return { success: false, error: data.errorMessage || `HTTP ${response.status}` };
    }

    const tradeId = data.orderFillTransaction?.tradeOpened?.tradeID
      ?? data.relatedTransactionIDs?.[0]
      ?? 'unknown';

    console.log(`✅ OANDA Order placed: ${instrument} ${units > 0 ? 'BUY' : 'SELL'} ${Math.abs(units)} units — tradeId: ${tradeId}`);

    return {
      success: true,
      tradeId,
      instrument,
      units: Math.abs(units),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Ferme un trade OANDA par son tradeId.
 */
export async function closeOrder(tradeId: string): Promise<{ success: boolean; error?: string }> {
  if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
    return { success: false, error: 'Credentials OANDA non configurés.' };
  }

  try {
    const response = await fetch(
      `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/trades/${tradeId}/close`,
      { method: 'PUT', headers: oandaHeaders() }
    );

    if (!response.ok) {
      const data: any = await response.json().catch(() => ({}));
      return { success: false, error: data.errorMessage || `HTTP ${response.status}` };
    }

    console.log(`🔒 OANDA Trade closed: tradeId ${tradeId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Retourne la liste des trades ouverts sur le compte OANDA.
 */
export async function getOpenTrades(): Promise<OandaOpenTrade[]> {
  if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) return [];

  try {
    const response = await fetch(
      `${BASE_URL}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
      { headers: oandaHeaders() }
    );

    if (!response.ok) return [];

    const data: any = await response.json();
    return (data.trades ?? []).map((t: any) => ({
      tradeId:        t.id,
      instrument:     t.instrument,
      units:          Math.abs(parseFloat(t.currentUnits)),
      openPrice:      parseFloat(t.price),
      unrealizedPnl:  parseFloat(t.unrealizedPL),
      openedAt:       t.openTime,
    }));
  } catch {
    return [];
  }
}
