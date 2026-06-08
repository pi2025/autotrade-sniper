
import { MarketData, TechnicalIndicators, SignalType, AssetConfig, AssetType, TradeSetup, StrategyParams, DonchianChannel, MarketPhase, ScoreFactor } from '../types';

export const STRATEGIES: StrategyParams[] = [
  {
    id: 'forex_titan_v18_stabilized',
    name: 'V18 Titan (Stabilized)',
    description: 'Filtres de tendance stricts. SL large (ATR 2.8x) et Breakout sur 12h pour ignorer le bruit du marché.',
    maShortPeriod: 20,
    maLongPeriod: 50,
    adxThreshold: 25, // Seuil standard institutionnel (>25 = tendance forte)
    entryType: 'DONCHIAN_BREAKOUT',
    donchianPeriod: 50, // Période plus longue (~12.5h)
    stopLossAtrMultiplier: 2.8, // SL plus large
    exitType: 'ATR_TRAIL',
    riskPerTradePercent: 0.5,
    capitalBase: 10000,
    breakevenTriggerR: 1.5, // Breakeven tardif — laisse le trade respirer
    exitLogic: 'ATR_TRAIL',
    maxHoldPeriod: 400,
  },
  {
    id: 'forex_sniper_v15_quantum',
    name: 'V15 Sniper Quantum',
    description: 'Algorithme Sniper optimisé. Filtrage ADX + Choppiness + Fan Widening. TP 2R réaliste.',
    maShortPeriod: 10,
    maLongPeriod: 30,
    adxThreshold: 22, // Seuil abaissé : >20 = tendance présente (littérature Wilder)
    entryType: 'DONCHIAN_BREAKOUT',
    donchianPeriod: 24,
    stopLossAtrMultiplier: 2.0,
    exitType: 'ATR_TRAIL',
    riskPerTradePercent: 1.0,
    capitalBase: 10000,
    breakevenTriggerR: 1.5, // Breakeven à 1.5R — évite les sorties à 0 sur pullback normal
    exitLogic: 'ATR_TRAIL',
    maxHoldPeriod: 200,
  }
];

export const DEFAULT_STRATEGY = STRATEGIES[1]; // Utiliser V15 par défaut

const calculateEMA = (data: number[], period: number): number => {
  const len = data.length;
  if (len < period) return data[len - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < len; i++) {
    ema = (data[i] - ema) * k + ema;
  }
  return ema;
};

const calculateChoppiness = (highs: number[], lows: number[], closes: number[], period: number = 14): number => {
  const len = closes.length;
  if (len < period + 1) return 50;

  const trSum = calculateATRSum(highs, lows, closes, period);
  const highestHigh = Math.max(...highs.slice(len - period));
  const lowestLow = Math.min(...lows.slice(len - period));
  const range = highestHigh - lowestLow;

  if (range === 0) return 100;
  
  return 100 * (Math.log10(trSum / range) / Math.log10(period));
};

const calculateATRSum = (highs: number[], lows: number[], closes: number[], period: number): number => {
  const len = closes.length;
  let sum = 0;
  for (let i = len - period; i < len; i++) {
    const hl = highs[i] - lows[i];
    const hc = i > 0 ? Math.abs(highs[i] - closes[i - 1]) : hl;
    const lc = i > 0 ? Math.abs(lows[i] - closes[i - 1]) : hl;
    sum += Math.max(hl, hc, lc);
  }
  return sum;
};

const calculateATR = (highs: number[], lows: number[], closes: number[], period: number = 14): number => {
  return calculateATRSum(highs, lows, closes, period) / period;
};

const calculateDonchian = (highs: number[], lows: number[], period: number): DonchianChannel => {
  const len = highs.length;
  if (len <= period) return { upper: highs[len-1] || 0, lower: lows[len-1] || 0, middle: highs[len-1] || 0 };
  let upper = -Infinity;
  let lower = Infinity;
  for (let i = len - period - 1; i < len - 1; i++) {
    if (highs[i] > upper) upper = highs[i];
    if (lows[i] < lower) lower = lows[i];
  }
  return { upper, lower, middle: (upper + lower) / 2 };
};

const calculateADXValues = (highs: number[], lows: number[], closes: number[], period: number = 14): number[] => {
  const len = closes.length;
  if (len < period * 2) return [0];
  
  const adxList: number[] = [];
  const tr: number[] = [];
  const dmPlus: number[] = [];
  const dmMinus: number[] = [];

  for (let i = 1; i < len; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    const up = highs[i] - highs[i-1], down = lows[i-1] - lows[i];
    dmPlus.push((up > down && up > 0) ? up : 0);
    dmMinus.push((down > up && down > 0) ? down : 0);
  }

  for (let i = period; i < tr.length; i++) {
    const sTR = tr.slice(i-period, i).reduce((a, b) => a + b, 0) / period;
    const sP = dmPlus.slice(i-period, i).reduce((a, b) => a + b, 0) / period;
    const sM = dmMinus.slice(i-period, i).reduce((a, b) => a + b, 0) / period;
    
    const dP = (sTR > 0 ? (sP / sTR) : 0) * 100;
    const dM = (sTR > 0 ? (sM / sTR) : 0) * 100;
    const dx = (dP + dM) > 0 ? (Math.abs(dP - dM) / (dP + dM)) * 100 : 0;
    adxList.push(dx);
  }

  return adxList;
};

const calculateBollingerBands = (closes: number[], period: number = 20, stdDevMultiplier: number = 2, squeezeLookback: number = 100) => {
  const len = closes.length;
  if (len < period) return { upper: 0, middle: 0, lower: 0, bandwidth: 0, isSqueezing: false };

  const slice = closes.slice(len - period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.map(p => Math.pow(p - middle, 2)).reduce((a, b) => a + b, 0) / period);

  const upper = middle + (stdDev * stdDevMultiplier);
  const lower = middle - (stdDev * stdDevMultiplier);
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;

  let isSqueezing = false;
  if (len >= squeezeLookback + period) {
    const historicalBandwidths: number[] = [];
    for (let i = len - squeezeLookback; i < len; i++) {
        const histSlice = closes.slice(i - period, i);
        const histMiddle = histSlice.reduce((a, b) => a + b, 0) / period;
        const histStdDev = Math.sqrt(histSlice.map(p => Math.pow(p - histMiddle, 2)).reduce((a, b) => a + b, 0) / period);
        const histUpper = histMiddle + (histStdDev * stdDevMultiplier);
        const histLower = histMiddle - (histStdDev * stdDevMultiplier);
        historicalBandwidths.push(histMiddle > 0 ? ((histUpper - histLower) / histMiddle) * 100 : 0);
    }
    const minBandwidth = Math.min(...historicalBandwidths);
    if (bandwidth <= minBandwidth * 1.15) {
        isSqueezing = true;
    }
  }

  return { upper, middle, lower, bandwidth, isSqueezing };
};

const calculateRSI = (closes: number[], period: number = 14): number => {
  const len = closes.length;
  if (len < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = len - period; i < len; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
};

export const calculateIndicators = (
  closes: number[], highs: number[], lows: number[], opens: number[], volumes: number[],
  strategy: StrategyParams, symbol: string = 'unknown'
): TechnicalIndicators | null => {
  const len = closes.length;
  if (len < 250) return null;

  const lastPrice = closes[len - 1];
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200); 
  const emaH4 = calculateEMA(closes, 800);
  
  const maShort = calculateEMA(closes, strategy.maShortPeriod);
  const maLong = calculateEMA(closes, strategy.maLongPeriod);
  const atr = calculateATR(highs, lows, closes, 14);
  
  const adxValues = calculateADXValues(highs, lows, closes, 14);
  const adx = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 0;
  const prevAdx = adxValues.length > 1 ? adxValues[adxValues.length - 2] : 0;
  const adxSlope = adx > prevAdx ? 'RISING' : 'FALLING';

  const choppiness = calculateChoppiness(highs, lows, closes, 14);
  const rsi = calculateRSI(closes, 14);

  const donchian = calculateDonchian(highs, lows, strategy.donchianPeriod);
  const bollingerBands = calculateBollingerBands(closes);

  const highestHigh = Math.max(...highs.slice(-strategy.donchianPeriod));
  const lowestLow = Math.min(...lows.slice(-strategy.donchianPeriod));
  
  const chandelierExit = lastPrice > ema50 
    ? highestHigh - (atr * strategy.stopLossAtrMultiplier)
    : lowestLow + (atr * strategy.stopLossAtrMultiplier);

  const m15Trend = lastPrice > ema50 ? 'BULL' : 'BEAR';
  // H4 trend basé sur EMA200 (standard institutionnel) au lieu de EMA800 (trop lent, trop de faux rejets)
  const h4Trend = lastPrice > ema200 ? 'BULL' : 'BEAR';

  // Fan Widening : moyenne du spread EMA20/50 sur 5 bougies vs 10 bougies
  // Plus stable qu'une comparaison bougie-à-bougie (évite les faux rejets sur micro-pullback)
  const spreadRecent: number[] = [];
  const spreadOlder: number[] = [];
  for (let i = 1; i <= 10; i++) {
    const e20 = calculateEMA(closes.slice(0, -i), 20);
    const e50 = calculateEMA(closes.slice(0, -i), 50);
    const sp = Math.abs(e20 - e50);
    if (i <= 5) spreadRecent.push(sp);
    spreadOlder.push(sp);
  }
  const avgSpreadRecent = spreadRecent.reduce((a, b) => a + b, 0) / spreadRecent.length;
  const avgSpreadOlder = spreadOlder.reduce((a, b) => a + b, 0) / spreadOlder.length;
  const isWidening = avgSpreadRecent > avgSpreadOlder;

  return {
    maShort, maLong, maSlope: maShort - maLong, atr, adx, adxSlope, donchian, rsi, 
    ema20, ema50, ema200, emaH4, bollingerBands,
    trendContext: lastPrice > ema200 ? 'BULLISH' : 'BEARISH',
    volumeTrend: (() => {
      if (!volumes || volumes.length < 40) return 'NEUTRAL' as const;
      const recentVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const avgVol = volumes.slice(-40).reduce((a, b) => a + b, 0) / 40;
      if (recentVol > avgVol * 1.3) return 'HIGH' as const;
      if (recentVol < avgVol * 0.7) return 'LOW' as const;
      return 'NEUTRAL' as const;
    })(),
    marketPhase: (() => {
      // Wyckoff-inspired : prix vs EMAs + ADX
      const aboveEma200 = lastPrice > ema200;
      const aboveEma50 = lastPrice > ema50;
      if (aboveEma200 && aboveEma50 && adx > 25) return MarketPhase.MARKUP;
      if (!aboveEma200 && !aboveEma50 && adx > 25) return MarketPhase.MARKDOWN;
      if (aboveEma200 && !aboveEma50) return MarketPhase.DISTRIBUTION;
      if (!aboveEma200 && aboveEma50) return MarketPhase.ACCUMULATION;
      // ADX faible = range → distribution ou accumulation selon la position
      return aboveEma200 ? MarketPhase.DISTRIBUTION : MarketPhase.ACCUMULATION;
    })(),
    chandelierExit,
    choppiness,
    lastPrices: closes.slice(-20), // On garde les 20 derniers prix pour l'IA
    mtfAlignment: {
      m15: m15Trend,
      h4: h4Trend,
      isAligned: m15Trend === h4Trend
    },
    isWidening // On l'ajoute dynamiquement pour l'analyse
  } as any;
};

// Contexte économique pré-calculé par server.ts (évite de rendre analyzeMarket async)
export interface EconomicContext {
  isSoon: boolean;
  events: { title: string; currency: string; minutesUntil: number }[];
}

export const analyzeMarket = (
  symbol: string, price: number, ind: TechnicalIndicators | null,
  strategy: StrategyParams = DEFAULT_STRATEGY,
  economicContext?: EconomicContext
): { signal: any, diagnostic: string } => {
  if (!ind) return { signal: null, diagnostic: "Indicateurs insuffisants" };

  // Filtre macro — priorité maximale, avant tous les filtres techniques
  if (economicContext?.isSoon) {
    const labels = economicContext.events
      .map(e => {
        const when = e.minutesUntil < 0
          ? `il y a ${Math.abs(e.minutesUntil)}min`
          : `dans ${e.minutesUntil}min`;
        return `${e.currency} ${e.title} (${when})`;
      })
      .join(' | ');
    return { signal: null, diagnostic: `Rejet: Annonce imminente — ${labels}` };
  }

  const isBullFan = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const isBearFan = price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;

  const isAdxRising = ind.adxSlope === 'RISING';
  const isAdxStrong = ind.adx >= strategy.adxThreshold;
  const mtfOk = ind.mtfAlignment?.isAligned;
  const isNotChoppy = ind.choppiness < 55; // Plus strict (61.8 est le max, 55 est plus sûr)
  const isWidening = (ind as any).isWidening;

  if (!mtfOk) return { signal: null, diagnostic: "Rejet: Désalignement Temporel M15/H4" };
  if (!isNotChoppy) return { signal: null, diagnostic: `Rejet: Marché trop haché (Choppiness: ${ind.choppiness.toFixed(1)})` };
  // Bollinger Squeeze = bonus de qualité, pas un bloqueur (trop restrictif sinon)
  if (!isAdxStrong) return { signal: null, diagnostic: `Rejet: ADX ${ind.adx.toFixed(1)} < ${strategy.adxThreshold}` };
  if (!isAdxRising) return { signal: null, diagnostic: "Rejet: Momentum en baisse" };
  if (!isWidening) return { signal: null, diagnostic: "Rejet: Tendance s'essouffle (Fan narrowing)" };
  
  if (ind.rsi > 72) return { signal: null, diagnostic: `Rejet: RSI Sur-acheté (${ind.rsi.toFixed(1)})` };
  if (ind.rsi < 28) return { signal: null, diagnostic: `Rejet: RSI Sur-vendu (${ind.rsi.toFixed(1)})` };

  // Guard ATR=0 — données insuffisantes ou marché fermé
  if (!ind.atr || ind.atr <= 0) return { signal: null, diagnostic: "Rejet: ATR nul — données insuffisantes" };

  // Buffer basé sur ATR (adaptif à la volatilité) au lieu de % fixe
  const buffer = ind.atr * 0.15;
  let type = null;
  
  if (price > (ind.donchian.upper + buffer) && isBullFan) {
    type = SignalType.BUY;
  } else if (price < (ind.donchian.lower - buffer) && isBearFan) {
    type = SignalType.SELL;
  }
  
  if (!type) {
    const reason = (!isBullFan && !isBearFan) ? "Triple EMA Fan non ordonné" : "Attente Breakout Bufferisé";
    return { signal: null, diagnostic: `Rejet: ${reason}` };
  }

  // Score composite réel basé sur la qualité des conditions
  let qualityScore = 50; // base neutre
  // ADX fort et croissant = meilleure probabilité
  qualityScore += Math.min((ind.adx - strategy.adxThreshold) * 1.5, 15);
  // Choppiness bas = tendance propre
  qualityScore += ind.choppiness < 40 ? 10 : ind.choppiness < 50 ? 5 : 0;
  // Fan widening = momentum croissant
  qualityScore += isWidening ? 5 : 0;
  // MTF alignment = confirmation multi-timeframe
  qualityScore += mtfOk ? 8 : 0;
  // Bollinger squeeze = compression avant expansion
  qualityScore += ind.bollingerBands.isSqueezing ? 7 : 0;
  // RSI dans zone saine (pas extrême)
  qualityScore += (ind.rsi > 35 && ind.rsi < 65) ? 5 : 0;
  const winProbability = Math.max(40, Math.min(95, Math.floor(qualityScore)));

  const atrBuffer = ind.atr * strategy.stopLossAtrMultiplier;
  const stopLoss = type === SignalType.BUY ? price - atrBuffer : price + atrBuffer;
  const riskDistance = Math.abs(price - stopLoss);
  
  // TP réaliste : 2R pour M15 — atteignable avant que le trailing stop ne ferme le trade
  const rrRatio = 2;
  const takeProfit = type === SignalType.BUY ? price + (riskDistance * rrRatio) : price - (riskDistance * rrRatio);
  
  let estimatedDuration = "~3-8 Jours";
  if (ind.atr > 0) {
      const distanceToTarget = Math.abs(takeProfit - price);
      const estimatedCandles = distanceToTarget / ind.atr;
      const hours = (estimatedCandles * 15) / 60;
      const days = hours / 24;
      if (hours < 24) estimatedDuration = `~${Math.round(hours)} Heures`;
      else estimatedDuration = `~${days.toFixed(1)} Jours`;
  }

  return {
    diagnostic: `🎯 Signal validé (score: ${winProbability}%)`,
    signal: {
      type, 
      strength: winProbability, 
      winProbability, 
      reasoning: [
        `Tendance de fond H4 confirmée (${ind.mtfAlignment?.h4})`,
        `Triple EMA Fan (20/50/200) aligné`,
        `Momentum ADX: ${ind.adx.toFixed(1)} (${ind.adxSlope})`,
        `Choppiness: ${ind.choppiness.toFixed(1)} — marché tendanciel`,
        ...(ind.bollingerBands.isSqueezing ? [`Compression de Volatilité (Squeeze) détectée`] : []),
      ],
      scoreBreakdown: [
        {label: 'Alignement H4', score: 30, type: 'POSITIVE'},
        {label: 'Triple Fan', score: 25, type: 'POSITIVE'},
        {label: 'Momentum ADX', score: 25, type: 'POSITIVE'},
        ...(ind.bollingerBands.isSqueezing ? [{label: 'Squeeze Volatilité', score: 15, type: 'POSITIVE' as const}] : []),
        {label: 'Choppiness bas', score: ind.choppiness < 40 ? 10 : 5, type: ind.choppiness < 45 ? 'POSITIVE' as const : 'NEUTRAL' as const},
      ],
      estimatedDuration,
      tradeSetup: {
        entryPrice: price, 
        stopLoss, 
        takeProfit,
        positionSizeUnit: (strategy.capitalBase * (strategy.riskPerTradePercent / 100)) / riskDistance, 
        riskAmount: strategy.capitalBase * (strategy.riskPerTradePercent / 100), 
        riskRewardRatio: rrRatio,
        breakevenPrice: type === SignalType.BUY ? price + (riskDistance * strategy.breakevenTriggerR) : price - (riskDistance * strategy.breakevenTriggerR)
      }
    }
  };
};

export const INITIAL_ASSETS: AssetConfig[] = [
  // Forex - Majors
  { symbol: 'EURUSD=X', type: AssetType.FOREX, active: true, name: "EUR/USD" },
  { symbol: 'GBPUSD=X', type: AssetType.FOREX, active: true, name: "GBP/USD" },
  { symbol: 'USDJPY=X', type: AssetType.FOREX, active: true, name: "USD/JPY" },
  { symbol: 'AUDUSD=X', type: AssetType.FOREX, active: true, name: "AUD/USD" },
  { symbol: 'USDCAD=X', type: AssetType.FOREX, active: true, name: "USD/CAD" },
  { symbol: 'USDCHF=X', type: AssetType.FOREX, active: true, name: "USD/CHF" },
  { symbol: 'NZDUSD=X', type: AssetType.FOREX, active: true, name: "NZD/USD" },
  
  // Forex - Crosses
  { symbol: 'EURGBP=X', type: AssetType.FOREX, active: true, name: "EUR/GBP" },
  { symbol: 'EURJPY=X', type: AssetType.FOREX, active: true, name: "EUR/JPY" },
  { symbol: 'EURAUD=X', type: AssetType.FOREX, active: true, name: "EUR/AUD" },
  { symbol: 'EURCHF=X', type: AssetType.FOREX, active: true, name: "EUR/CHF" },
  { symbol: 'GBPJPY=X', type: AssetType.FOREX, active: true, name: "GBP/JPY" },
  { symbol: 'AUDJPY=X', type: AssetType.FOREX, active: true, name: "AUD/JPY" },
  { symbol: 'CHFJPY=X', type: AssetType.FOREX, active: true, name: "CHF/JPY" },
  { symbol: 'EURNZD=X', type: AssetType.FOREX, active: true, name: "EUR/NZD" },
  { symbol: 'GBPAUD=X', type: AssetType.FOREX, active: true, name: "GBP/AUD" },
  { symbol: 'CADJPY=X', type: AssetType.FOREX, active: true, name: "CAD/JPY" },

  // Crypto
  { symbol: 'BTC-USD', type: AssetType.CRYPTO, active: true, name: "Bitcoin" },
  { symbol: 'ETH-USD', type: AssetType.CRYPTO, active: true, name: "Ethereum" },
  { symbol: 'SOL-USD', type: AssetType.CRYPTO, active: true, name: "Solana" },
  { symbol: 'BNB-USD', type: AssetType.CRYPTO, active: true, name: "Binance Coin" },
  { symbol: 'XRP-USD', type: AssetType.CRYPTO, active: true, name: "Ripple" },
  
  // Matières Premières
  { symbol: 'GC=F', type: AssetType.COMMODITY, active: true, name: "Or (XAU/USD)" },
  { symbol: 'SI=F', type: AssetType.COMMODITY, active: true, name: "Argent (XAG/USD)" },
  { symbol: 'CL=F', type: AssetType.COMMODITY, active: true, name: "Pétrole (WTI)" },
  
  // Indices
  { symbol: '^GSPC', type: AssetType.INDEX, active: true, name: "S&P 500" },
  { symbol: '^IXIC', type: AssetType.INDEX, active: true, name: "NASDAQ" },
  { symbol: '^FCHI', type: AssetType.INDEX, active: true, name: "CAC 40" }
];
