
/**
 * cTrader Open API Service pour AutoTrade Sniper V15
 *
 * Utilise @reiryoku/ctrader-layer comme couche de transport Protobuf.
 * Interface identique à oandaService.ts → swap en une seule ligne d'import dans server.ts.
 *
 * Prérequis :
 *   npm install @reiryoku/ctrader-layer
 *
 * Variables d'environnement requises :
 *   CTRADER_CLIENT_ID       — Client ID depuis open.ctrader.com
 *   CTRADER_CLIENT_SECRET   — Client Secret depuis open.ctrader.com
 *   CTRADER_ACCESS_TOKEN    — Access Token OAuth (obtenu via navigateur, ~30 jours)
 *   CTRADER_ACCOUNT_ID      — ctidTraderAccountId (ex: 9932624)
 *   CTRADER_LIVE=false      — true = compte réel, false = demo (défaut)
 *   CTRADER_RISK_PERCENT=1  — % du solde risqué par trade (défaut: 1%)
 *
 * Comment obtenir Client ID / Client Secret :
 *   1. Aller sur https://open.ctrader.com → S'inscrire / Se connecter
 *   2. "Applications" → "New Application"
 *   3. Remplir : nom, description, redirect URI (ex: http://localhost:3000/callback)
 *   4. Soumettre → attendre l'approbation Spotware (~24-48h)
 *   5. Une fois approuvé : copier Client ID et Client Secret
 *
 * Comment obtenir l'Access Token :
 *   1. Ouvrir dans un navigateur :
 *      https://connect.spotware.com/apps/auth?client_id=YOUR_CLIENT_ID
 *        &redirect_uri=http://localhost:3000/callback
 *        &scope=trading
 *   2. S'authentifier avec le compte cTrader (IC Markets demo)
 *   3. Autoriser l'application
 *   4. Le navigateur redirige vers :
 *      http://localhost:3000/callback?code=AUTHORIZATION_CODE
 *   5. Échanger le code contre un token :
 *      POST https://connect.spotware.com/apps/token
 *        grant_type=authorization_code
 *        &code=AUTHORIZATION_CODE
 *        &client_id=YOUR_CLIENT_ID
 *        &client_secret=YOUR_CLIENT_SECRET
 *        &redirect_uri=http://localhost:3000/callback
 *   6. Réponse JSON contient accessToken (~30 jours) et refreshToken (permanent)
 *   7. Stocker accessToken dans .env comme CTRADER_ACCESS_TOKEN
 */

import { CTraderConnection } from "@reiryoku/ctrader-layer";
import { Signal, AssetType, SignalType } from '../types.ts';

// --- CONFIGURATION ---
const CLIENT_ID      = process.env.CTRADER_CLIENT_ID || '';
const CLIENT_SECRET  = process.env.CTRADER_CLIENT_SECRET || '';
const ACCESS_TOKEN   = process.env.CTRADER_ACCESS_TOKEN || '';
const ACCOUNT_ID     = parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
const IS_LIVE        = process.env.CTRADER_LIVE === 'true';
const RISK_PERCENT   = parseFloat(process.env.CTRADER_RISK_PERCENT || '1') / 100;

const HOST = IS_LIVE ? 'live.ctraderapi.com' : 'demo.ctraderapi.com';
const PORT = 5035; // Protobuf over TLS

// --- PAYLOAD TYPE NAMES (cTrader Open API 2.0) ---
// La lib @reiryoku/ctrader-layer v2 exige des noms string, pas des IDs numériques
const PT = {
  HEARTBEAT:           'ProtoHeartbeatEvent',
  APP_AUTH_REQ:        'ProtoOAApplicationAuthReq',
  ACCOUNT_AUTH_REQ:    'ProtoOAAccountAuthReq',
  NEW_ORDER_REQ:       'ProtoOANewOrderReq',
  EXECUTION_EVENT:     'ProtoOAExecutionEvent',       // 2126 (pas 2107)
  CLOSE_POSITION_REQ:  'ProtoOAClosePositionReq',
  SYMBOLS_LIST_REQ:    'ProtoOASymbolsListReq',
  RECONCILE_REQ:       'ProtoOAReconcileReq',         // 2124 (pas 2122)
  TRADER_REQ:          'ProtoOATraderReq',             // 2121 (pas 2149)
} as const;

// Trade side / Order type (cTrader enums)
const TRADE_SIDE = { BUY: 1, SELL: 2 } as const;
const ORDER_TYPE = { MARKET: 1 } as const;

// --- MAPPING Yahoo Finance → nom de symbole cTrader (IC Markets) ---
const SYMBOL_MAP: Record<string, string> = {
  // Forex - Majors
  'EURUSD=X': 'EURUSD',
  'GBPUSD=X': 'GBPUSD',
  'USDJPY=X': 'USDJPY',
  'AUDUSD=X': 'AUDUSD',
  'USDCAD=X': 'USDCAD',
  'USDCHF=X': 'USDCHF',
  'NZDUSD=X': 'NZDUSD',
  // Forex - Crosses
  'EURGBP=X': 'EURGBP',
  'EURJPY=X': 'EURJPY',
  'EURAUD=X': 'EURAUD',
  'EURCHF=X': 'EURCHF',
  'GBPJPY=X': 'GBPJPY',
  'AUDJPY=X': 'AUDJPY',
  'CHFJPY=X': 'CHFJPY',
  'EURNZD=X': 'EURNZD',
  'GBPAUD=X': 'GBPAUD',
  'CADJPY=X': 'CADJPY',
  // Crypto (IC Markets cTrader)
  'BTC-USD':  'BTCUSD',
  'ETH-USD':  'ETHUSD',
  'SOL-USD':  'SOLUSD',
  'BNB-USD':  'BNBUSD',
  'XRP-USD':  'XRPUSD',
  // Matières premières
  'GC=F':     'XAUUSD',
  'SI=F':     'XAGUSD',
  'CL=F':     'XTIUSD',   // WTI Crude Oil sur IC Markets cTrader
  // Indices
  '^GSPC':    'US500',     // S&P 500
  '^IXIC':    'USTEC',     // NASDAQ
  '^FCHI':    'FRA40',     // CAC 40
};

// --- TYPES INTERNES (identiques à oandaService pour compatibilité) ---
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

// --- ÉTAT DE CONNEXION ---
let connection: CTraderConnection | null = null;
let symbolIdMap = new Map<string, number>(); // symbolName → symbolId
let symbolNameMap = new Map<number, string>(); // symbolId → symbolName
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isAuthenticated = false;

// --- GESTION DE CONNEXION ---

/**
 * Établit la connexion cTrader et authentifie l'application + le compte.
 * Idempotent : ne reconnecte pas si déjà authentifié.
 */
async function ensureConnection(): Promise<void> {
  if (isAuthenticated && connection) return;

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN || !ACCOUNT_ID) {
    throw new Error('Variables CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN ou CTRADER_ACCOUNT_ID manquantes.');
  }

  // Nettoyer toute connexion précédente
  disconnect();

  connection = new CTraderConnection({ host: HOST, port: PORT });
  await connection.open();

  // Étape 1 — Authentification de l'application
  await connection.sendCommand(PT.APP_AUTH_REQ, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });

  // Étape 2 — Authentification du compte de trading
  await connection.sendCommand(PT.ACCOUNT_AUTH_REQ, {
    ctidTraderAccountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
  });

  // Étape 3 — Charger la liste des symboles pour le mapping symbolName → symbolId
  const symbolsRes: any = await connection.sendCommand(PT.SYMBOLS_LIST_REQ, {
    ctidTraderAccountId: ACCOUNT_ID,
  });

  symbolIdMap.clear();
  symbolNameMap.clear();
  for (const sym of (symbolsRes.symbol ?? [])) {
    if (sym.symbolName && sym.symbolId) {
      symbolIdMap.set(sym.symbolName, sym.symbolId);
      symbolNameMap.set(sym.symbolId, sym.symbolName);
    }
  }

  console.log(`✅ cTrader connecté — ${symbolIdMap.size} symboles chargés (${IS_LIVE ? 'LIVE' : 'DEMO'})`);

  // Heartbeat toutes les 10s (cTrader coupe après ~30s d'inactivité)
  heartbeatTimer = setInterval(() => {
    connection?.sendCommand(PT.HEARTBEAT, {}).catch(() => {});
  }, 10_000);

  isAuthenticated = true;
}

function disconnect() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  connection = null;
  isAuthenticated = false;
}

/**
 * Résout un symbole Yahoo en symbolId cTrader.
 */
function resolveSymbolId(yahooSymbol: string): number | null {
  const ctraderName = SYMBOL_MAP[yahooSymbol];
  if (!ctraderName) return null;
  return symbolIdMap.get(ctraderName) ?? null;
}

/**
 * Calcule le volume cTrader (en unités de base currency) pour respecter le risque cible.
 *
 * Volume cTrader = base currency units :
 *   - 100000 = 1.00 lot standard
 *   -  10000 = 0.10 lot mini
 *   -   1000 = 0.01 lot micro (minimum IC Markets)
 *
 * Logique de sizing identique à oandaService :
 *   - Forex USD-quoté : volume = riskAmount / slDistance
 *   - Forex USD-base  : volume = (riskAmount * price) / slDistance
 *   - Indices / Matières premières : arrondi entier
 *
 * Arrondi au pas de 1000 (0.01 lot minimum).
 * Plafond de sécurité : 100 000 (1 lot standard max).
 */
function calculateVolume(signal: Signal, balance: number): number {
  const riskAmount = balance * RISK_PERCENT;
  const slDistance = Math.abs(signal.priceAtSignal - signal.tradeSetup.stopLoss);
  if (slDistance === 0) return 0;

  const ctraderName = SYMBOL_MAP[signal.asset] ?? '';
  const isUsdBase = ['USDJPY', 'USDCAD', 'USDCHF'].includes(ctraderName);

  // Valeur d'un pip/point par unité selon le type d'actif
  // cTrader volume = unités de base currency (100000 = 1 lot forex)
  // Pour les matières premières et indices, 1 unité = valeur du contrat
  const isCommodity = ['XAUUSD', 'XAGUSD', 'XTIUSD'].includes(ctraderName);
  const isIndex = ['US500', 'USTEC', 'FRA40'].includes(ctraderName);
  const isCrypto = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'XRPUSD'].includes(ctraderName);

  let rawVolume: number;

  if (isCommodity) {
    // Commodités : volume en unités (ex: 100 unités XAGUSD = 100 oz d'argent)
    // PnL = volume * slDistance, donc volume = riskAmount / slDistance
    rawVolume = riskAmount / slDistance;
    // cTrader commodités : volume en centièmes d'unité (100 = 1 unité)
    rawVolume = rawVolume * 100;
  } else if (isIndex) {
    // Indices : volume = riskAmount / slDistance (en points)
    // cTrader indices : volume en centièmes (100 = 1 contrat)
    rawVolume = (riskAmount / slDistance) * 100;
  } else if (isCrypto) {
    // Sécurité: le multiplicateur crypto dépend des specs broker cTrader.
    // L'exécution crypto est bloquée dans placeOrder tant que ces specs ne sont pas validées.
    return 0;
  } else if (isUsdBase) {
    rawVolume = (riskAmount * signal.priceAtSignal) / slDistance;
  } else {
    rawVolume = riskAmount / slDistance;
  }

  // Pas d'arrondi et minimum selon le type d'actif
  let step: number;
  let minVolume: number;
  let maxVolume: number;

  if (isCommodity || isIndex) {
    step = 100;        // 0.01 contrat minimum
    minVolume = 100;   // 0.01 contrat
    maxVolume = 10000; // 100 contrats max
  } else if (isCrypto) {
    step = 1000000;           // 0.01 unité
    minVolume = 1000000;      // 0.01 unité minimum
    maxVolume = 100000000000; // 1000 unités max
  } else {
    step = 1000;       // 0.01 lot forex
    minVolume = 1000;  // 0.01 lot minimum
    maxVolume = 100000; // 1 lot standard max
  }

  let volume = Math.floor(rawVolume / step) * step;

  // Garantir le volume minimum si rawVolume > 0
  if (volume < minVolume && rawVolume > 0) {
    volume = minVolume;
  }

  return Math.min(volume, maxVolume);
}

/**
 * Convertit un prix en nombre entier × 10^digits pour les champs SL/TP cTrader.
 * cTrader accepte aussi les prix en double — on garde le double pour la simplicité.
 */
function priceToDouble(price: number): number {
  return price;
}

// --- FONCTIONS PUBLIQUES (même interface que oandaService) ---

/**
 * Vérifie que les credentials sont valides et retourne le statut de connexion.
 */
export async function testConnection(): Promise<OandaConnectionStatus> {
  if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN || !ACCOUNT_ID) {
    return {
      connected: false,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: ACCOUNT_ID ? ACCOUNT_ID.toString() : null,
      error: 'Variables CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN ou CTRADER_ACCOUNT_ID manquantes.',
    };
  }

  try {
    await ensureConnection();

    const traderRes: any = await connection!.sendCommand(PT.TRADER_REQ, {
      ctidTraderAccountId: ACCOUNT_ID,
    });

    const trader = traderRes.trader ?? {};
    return {
      connected: true,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: ACCOUNT_ID.toString(),
      balance: (trader.balance ?? 0) / 100, // cTrader stocke en cents
      currency: trader.depositAssetId ? 'USD' : 'USD', // On fixe USD pour le compte demo IC Markets
    };
  } catch (err: any) {
    disconnect();
    return {
      connected: false,
      mode: IS_LIVE ? 'LIVE' : 'DEMO',
      accountId: ACCOUNT_ID.toString(),
      error: err.message,
    };
  }
}

/**
 * Retourne le solde actuel du compte.
 */
export async function getAccountBalance(): Promise<{ balance: number; currency: string } | null> {
  try {
    await ensureConnection();

    const traderRes: any = await connection!.sendCommand(PT.TRADER_REQ, {
      ctidTraderAccountId: ACCOUNT_ID,
    });

    const trader = traderRes.trader ?? {};
    return {
      balance: (trader.balance ?? 0) / 100, // cents → USD
      currency: 'USD',
    };
  } catch (err: any) {
    console.error('cTrader getAccountBalance failed:', err.message);
    disconnect();
    return null;
  }
}

/**
 * Place un Market Order sur cTrader à partir d'un Signal V15.
 * Calcule automatiquement le volume (position sizing basé sur le risque).
 */
export async function placeOrder(signal: Signal): Promise<OandaOrderResult> {
  try {
    await ensureConnection();
  } catch (err: any) {
    return { success: false, error: `Connexion cTrader échouée: ${err.message}` };
  }

  if (signal.assetType !== AssetType.FOREX) {
    return {
      success: false,
      error: `Exécution cTrader bloquée pour ${signal.asset}: seuls les signaux FOREX sont autorisés tant que les tailles crypto/indices/commodités ne sont pas validées par symbole.`,
    };
  }

  const symbolId = resolveSymbolId(signal.asset);
  if (!symbolId) {
    return { success: false, error: `Symbole non supporté sur cTrader: ${signal.asset}` };
  }

  const acc = await getAccountBalance();
  if (!acc) {
    return { success: false, error: 'Impossible de récupérer le solde du compte.' };
  }

  const volume = calculateVolume(signal, acc.balance);
  if (volume === 0) {
    return { success: false, error: 'Volume calculé à 0 (SL trop proche ou solde insuffisant).' };
  }

  const tradeSide = signal.type === SignalType.BUY ? TRADE_SIDE.BUY : TRADE_SIDE.SELL;
  const ctraderName = SYMBOL_MAP[signal.asset] ?? signal.asset;

  try {
    const res: any = await connection!.sendCommand(PT.NEW_ORDER_REQ, {
      ctidTraderAccountId: ACCOUNT_ID,
      symbolId,
      orderType: ORDER_TYPE.MARKET,
      tradeSide,
      volume,
      stopLoss: priceToDouble(signal.tradeSetup.stopLoss),
      takeProfit: priceToDouble(signal.tradeSetup.takeProfit),
    });

    // L'API retourne un ProtoOAExecutionEvent avec la position ouverte.
    // Si aucune position/order ID n'est présent, on ne marque surtout pas l'ordre comme exécuté.
    const positionId = res.position?.positionId
      ?? res.order?.orderId;

    if (!positionId) {
      console.error('❌ cTrader order response without positionId/orderId:', JSON.stringify(res));
      return {
        success: false,
        error: `cTrader n'a pas confirmé de position pour ${ctraderName}. Ordre non marqué comme exécuté. Volume tenté: ${volume}.`,
        instrument: ctraderName,
        units: volume,
      };
    }

    console.log(`✅ cTrader Order placed: ${ctraderName} ${tradeSide === TRADE_SIDE.BUY ? 'BUY' : 'SELL'} vol=${volume} — positionId: ${positionId}`);

    return {
      success: true,
      tradeId: positionId.toString(),
      instrument: ctraderName,
      units: volume,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Ferme une position ouverte sur cTrader par son positionId.
 */
export async function closeOrder(tradeId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureConnection();
  } catch (err: any) {
    return { success: false, error: `Connexion cTrader échouée: ${err.message}` };
  }

  try {
    await connection!.sendCommand(PT.CLOSE_POSITION_REQ, {
      ctidTraderAccountId: ACCOUNT_ID,
      positionId: parseInt(tradeId, 10),
      volume: 0, // 0 = fermer la totalité de la position
    });

    console.log(`🔒 cTrader Position closed: positionId ${tradeId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Retourne la liste des positions ouvertes sur le compte cTrader.
 */
export async function getOpenTrades(): Promise<OandaOpenTrade[]> {
  try {
    await ensureConnection();
  } catch {
    return [];
  }

  try {
    const res: any = await connection!.sendCommand(PT.RECONCILE_REQ, {
      ctidTraderAccountId: ACCOUNT_ID,
    });

    return (res.position ?? []).map((p: any) => {
      const symbolName = symbolNameMap.get(p.tradeData?.symbolId) ?? `ID:${p.tradeData?.symbolId}`;
      return {
        tradeId:       (p.positionId ?? 0).toString(),
        instrument:     symbolName,
        units:          p.tradeData?.volume ?? 0,
        openPrice:      p.price ?? 0,
        unrealizedPnl:  (p.swap ?? 0) / 100, // approximation — le PnL exact nécessite le prix courant
        openedAt:       new Date(Number(p.tradeData?.openTimestamp ?? 0)).toISOString(),
      };
    });
  } catch {
    return [];
  }
}
