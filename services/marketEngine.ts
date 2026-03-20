
import { MarketData, TechnicalIndicators, SignalType, AssetConfig, AssetType, TradeSetup, StrategyParams, DonchianChannel, MarketPhase, ScoreFactor } from '../types';

export const STRATEGIES: StrategyParams[] = [
  {
    id: 'forex_titan_v18_stabilized',
    name: 'V18 Titan (Stabilized)',
    description: 'Filtres de tendance stricts. SL large (ATR 2.8x) et Breakout sur 12h pour ignorer le bruit du marché.',
    maShortPeriod: 20,
    maLongPeriod: 50, 
    adxThreshold: 32, // Plus strict
    entryType: 'DONCHIAN_BREAKOUT',
    donchianPeriod: 50, // Période plus longue (~12.5h)
    stopLossAtrMultiplier: 2.8, // SL plus large
    exitType: 'ATR_TRAIL', 
    riskPerTradePercent: 0.5, 
    capitalBase: 10000,
    breakevenTriggerR: 1.2, // Breakeven un peu plus tardif
    exitLogic: 'ATR_TRAIL',
    maxHoldPeriod: 400, // Permet aux trades de durer plus longtemps
  },
  {
    id: 'forex_sniper_v15_quantum',
    name: 'V15 Sniper Quantum',
    description: 'Algorithme Sniper optimisé. Filtrage ADX/Slope Strict + Choppiness + Fan Widening.',
    maShortPeriod: 10,
    maLongPeriod: 30, 
    adxThreshold: 28,
    entryType: 'DONCHIAN_BREAKOUT',
    donchianPeriod: 24,
    stopLossAtrMultiplier: 2.0,
    exitType: 'ATR_TRAIL', 
    riskPerTradePercent: 1.0, 
    capitalBase: 10000,
    breakevenTriggerR: 1.0,
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
  if (len < 800) return null;

  const lastPrice = closes[len - 1];
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200); 
  const emaH4 = calculateEMA(closes, 800);
  
  const maShort = calculateEMA(closes, strategy.maShortPeriod);
  const maLong = calculateEMA(closes, strategy.maLongPeriod);
  const atr = calculateATR(highs, lows, closes, 14);
  
  const adxValues = calculateADXValues(highs, lows, closes, 14);
  const adx = adxValues[adxValues.length - 1] || 0;
  const prevAdx = adxValues[adxValues.length - 2] || 0;
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
  const h4Trend = lastPrice > emaH4 ? 'BULL' : 'BEAR';

  const ema20_prev = calculateEMA(closes.slice(0, -1), 20);
  const ema50_prev = calculateEMA(closes.slice(0, -1), 50);
  const currentSpread = Math.abs(ema20 - ema50);
  const prevSpread = Math.abs(ema20_prev - ema50_prev);
  const isWidening = currentSpread > prevSpread;

  return {
    maShort, maLong, maSlope: maShort - maLong, atr, adx, adxSlope, donchian, rsi, 
    ema20, ema50, ema200, emaH4, bollingerBands,
    trendContext: lastPrice > ema200 ? 'BULLISH' : 'BEARISH',
    volumeTrend: 'NEUTRAL', marketPhase: MarketPhase.MARKUP,
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

export const analyzeMarket = (
  symbol: string, price: number, ind: TechnicalIndicators | null, strategy: StrategyParams = DEFAULT_STRATEGY
): { signal: any, diagnostic: string } => {
  if (!ind) return { signal: null, diagnostic: "Indicateurs insuffisants" };
  
  const isBullFan = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const isBearFan = price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;

  const isAdxRising = ind.adxSlope === 'RISING';
  const isAdxStrong = ind.adx >= strategy.adxThreshold;
  const mtfOk = ind.mtfAlignment?.isAligned;
  const isNotChoppy = ind.choppiness < 55; // Plus strict (61.8 est le max, 55 est plus sûr)
  const isWidening = (ind as any).isWidening;

  if (!mtfOk) return { signal: null, diagnostic: "Rejet: Désalignement Temporel M15/H4" };
  if (!isNotChoppy) return { signal: null, diagnostic: `Rejet: Marché trop haché (Choppiness: ${ind.choppiness.toFixed(1)})` };
  if (!ind.bollingerBands.isSqueezing) return { signal: null, diagnostic: `Rejet: Volatilité explosive (No Squeeze)` };
  if (!isAdxStrong) return { signal: null, diagnostic: `Rejet: ADX ${ind.adx.toFixed(1)} < ${strategy.adxThreshold}` };
  if (!isAdxRising) return { signal: null, diagnostic: "Rejet: Momentum en baisse" };
  if (!isWidening) return { signal: null, diagnostic: "Rejet: Tendance s'essouffle (Fan narrowing)" };
  
  if (ind.rsi > 72) return { signal: null, diagnostic: `Rejet: RSI Sur-acheté (${ind.rsi.toFixed(1)})` };
  if (ind.rsi < 28) return { signal: null, diagnostic: `Rejet: RSI Sur-vendu (${ind.rsi.toFixed(1)})` };

  const buffer = price * 0.001; 
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

  const winProbability = Math.floor(68 + Math.min(ind.adx/5, 12));

  const atrBuffer = ind.atr * strategy.stopLossAtrMultiplier;
  const stopLoss = type === SignalType.BUY ? price - atrBuffer : price + atrBuffer;
  const riskDistance = Math.abs(price - stopLoss);
  
  // V18 Titan: Objectif TP très lointain pour laisser le Trailing Stop (Chandelier) faire le travail.
  const rrRatio = 10; 
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
    diagnostic: "🎯 Signal TITAN V18 Validé !",
    signal: {
      type, 
      strength: winProbability, 
      winProbability, 
      reasoning: [
        `Tendance de fond H4 confirmée`,
        `Compression de Volatilité (Squeeze)`,
        `Triple EMA Fan (20/50/200) aligné`,
        `Momentum ADX puissant et croissant (${ind.adx.toFixed(1)})`,
        `Stop-loss large pour absorber la volatilité`
      ],
      scoreBreakdown: [
        {label: 'Alignement H4', score: 35, type: 'POSITIVE'},
        {label: 'Squeeze Volatilité', score: 25, type: 'POSITIVE'},
        {label: 'Triple Fan', score: 20, type: 'POSITIVE'},
        {label: 'Momentum ADX', score: 20, type: 'POSITIVE'}
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
