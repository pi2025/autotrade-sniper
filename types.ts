
export enum AssetType {
  CRYPTO = 'CRYPTO',
  FOREX = 'FOREX',
  COMMODITY = 'COMMODITY',
  STOCK = 'STOCK',
  INDEX = 'INDEX',
}

export enum SignalType {
  BUY = 'LONG',
  SELL = 'SHORT',
  NEUTRAL = 'FLAT',
}

export enum SignalStatus {
  OPEN = 'OPEN',
  WIN = 'WIN',
  LOSS = 'LOSS'
}

export type AgentMode = 'SIGNALS_ONLY' | 'SEMI_AUTO' | 'AUTONOMOUS' | 'EMERGENCY_STOP';

export type AgentPositionSizingMode = 'RISK_PERCENT' | 'FIXED_AMOUNT' | 'FIXED_LOT';

export interface AgentPositionSizing {
  mode: AgentPositionSizingMode;
  riskPercent: number;
  fixedAmount: number;
  fixedLot: number;
  multiplier: number;
  forexMultiplier: number;
  cryptoMultiplier: number;
  commodityMultiplier: number;
  indexMultiplier: number;
  stockMultiplier: number;
  minVolumeUnits: number;
  maxVolumeUnits: number;
}

export interface AgentLimits {
  maxSimultaneousTrades: number;
  maxRiskPercent: number;
  maxDrawdownPercent: number;
  positionSizing: AgentPositionSizing;
}

export interface AgentStatus {
  mode: AgentMode;
  limits: AgentLimits;
  connected: boolean;
  balance: number;
  equity: number;
  openPositions: number;
}

export enum TimeFrame {
  M15 = '15m',
  H1 = '1h',
  H4 = '4h',
  D1 = '1d',
  W1 = '1w',
}

export enum MarketPhase {
  ACCUMULATION = 'ACCUMULATION',
  MARKUP = 'MARKUP',
  DISTRIBUTION = 'DISTRIBUTION',
  MARKDOWN = 'MARKDOWN',
}

export interface MarketData {
  symbol: string;
  price: number;
  timestamp: number;
  history: number[]; 
  highs: number[];   
  lows: number[];    
  opens: number[];   
  volumes: number[]; 
  dataSource?: 'LIVE_API' | 'SIMULATION';
}

export interface DonchianChannel {
  upper: number;
  lower: number;
  middle: number;
}

export interface TechnicalIndicators {
  maShort: number;    
  maLong: number;     
  maSlope: number;    
  atr: number;        
  adx: number;
  adxSlope: 'RISING' | 'FALLING' | 'FLAT';
  donchian: DonchianChannel;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;
    isSqueezing: boolean;
  };
  trendContext: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  rsi: number;
  ema20: number;
  ema50: number;
  ema200: number;
  emaH4: number; // For H4 trend context
  volumeTrend: 'HIGH' | 'LOW' | 'NEUTRAL';
  marketPhase: MarketPhase;
  chandelierExit: number;
  choppiness: number;
  lastPrices?: number[];
  mtfAlignment?: {
    m15: 'BULL' | 'BEAR' | 'NEUTRAL';
    h4: 'BULL' | 'BEAR' | 'NEUTRAL';
    isAligned: boolean;
  };
}

export interface TradeSetup {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number; 
  positionSizeUnit: number; 
  riskAmount: number; 
  riskRewardRatio: number;
  suggestedLot?: number;
  breakevenPrice?: number;
}

export interface ScoreFactor {
  label: string;
  score: number; 
  type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

export interface Signal {
  id: string;
  asset: string;
  assetType: AssetType;
  type: SignalType;
  timestamp: number;
  timeFrame: TimeFrame;
  priceAtSignal: number;
  trendStrength: number; 
  indicators: TechnicalIndicators;
  tradeSetup: TradeSetup;
  aiExplanation?: string;
  isNew?: boolean; 
  reasoning: string[];
  status: SignalStatus;
  closePrice?: number;
  closedAt?: number;
  pnl?: number; 
  confidence: number;
  winProbability: number; 
  scoreBreakdown: ScoreFactor[];
  estimatedDuration: string; 
  isBreakevenSet?: boolean;
  originalStopLoss?: number;
  ctraderPositionId?: string;
}

export interface AssetConfig {
  symbol: string;
  type: AssetType;
  active: boolean;
  name: string;
}

export interface StrategyParams {
  id: string;
  name: string;
  description: string;
  maShortPeriod: number;
  maLongPeriod: number;
  adxThreshold: number; 
  entryType: 'DONCHIAN_BREAKOUT' | 'MA_CROSS';
  donchianPeriod: number; 
  stopLossAtrMultiplier: number; 
  exitType: 'ATR_TRAIL' | 'OPPOSITE_SIGNAL';
  riskPerTradePercent: number; 
  capitalBase: number; 
  breakevenTriggerR: number;
  exitLogic: 'ATR_TRAIL' | 'ADX_FALL' | 'EMA_20_TOUCH';
  maxHoldPeriod: number;
}

export interface EmailConfig {
  enabled: boolean;
  serviceId: string;
  templateId: string;
  publicKey: string;
  targetEmail: string;
}

export interface BacktestResult {
  strategyId: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  period: string;
  equityCurve: { tradeNum: number; equity: number }[];
  avgTradeDuration: number;
}

declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}
