/**
 * Agent 4 : Risk Manager
 * Vérifie les règles de gestion du risque avant validation d'un trade.
 * Input : candidat + analyses technique + macro + portefeuille actuel
 * Output : décision risque (APPROVED/REDUCED/REJECTED) + sizing
 * Coût : $0 (calcul pur, pas d'IA)
 */

import { ScreenerCandidate } from './screenerAgent.ts';
import { TechnicalAnalysis } from './technicalAgent.ts';
import { MacroAnalysis } from './macroAgent.ts';
import { Signal, SignalStatus } from '../../types.ts';

export interface RiskDecision {
  status: 'APPROVED' | 'REDUCED' | 'REJECTED';
  maxRiskPercent: number;      // % du capital à risquer
  positionSizeMultiplier: number; // 0.0 à 1.0
  reasons: string[];
  correlationWarning: boolean;
  maxOpenPositions: number;
}

interface RiskConfig {
  maxOpenPositions: number;
  maxRiskPerTrade: number;      // % (ex: 1.0 = 1%)
  maxCorrelatedPositions: number;
  maxDailyLosses: number;
}

const DEFAULT_CONFIG: RiskConfig = {
  maxOpenPositions: 5,
  maxRiskPerTrade: 1.0,
  maxCorrelatedPositions: 2,
  maxDailyLosses: 3,
};

// Groupes de corrélation
const CORRELATION_GROUPS: Record<string, string[]> = {
  'USD_PAIRS': ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'],
  'EUR_CROSSES': ['EURUSD', 'EURJPY', 'EURGBP', 'EURAUD', 'EURCHF', 'EURNZD'],
  'GBP_CROSSES': ['GBPUSD', 'GBPJPY', 'EURGBP', 'GBPAUD'],
  'JPY_CROSSES': ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'CHFJPY'],
  'CRYPTO_MAJOR': ['BTCUSD', 'ETHUSD'],
  'CRYPTO_ALT': ['SOLUSD', 'BNBUSD', 'XRPUSD'],
  'COMMODITIES': ['XAUUSD', 'XAGUSD'],
  'INDICES': ['US30', 'US500', 'USTEC', 'DE40', 'UK100', 'JP225', 'FR40'],
};

export function runRiskCheck(
  candidate: ScreenerCandidate,
  technical: TechnicalAnalysis,
  macro: MacroAnalysis,
  openSignals: Signal[],
  config: RiskConfig = DEFAULT_CONFIG
): RiskDecision {
  const reasons: string[] = [];
  let multiplier = 1.0;
  let rejected = false;

  const openPositions = openSignals.filter(s => s.status === SignalStatus.OPEN);

  // 1. Nombre max de positions ouvertes
  if (openPositions.length >= config.maxOpenPositions) {
    reasons.push(`Max positions atteint (${openPositions.length}/${config.maxOpenPositions})`);
    rejected = true;
  }

  // 2. Pertes journalières max
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();
  const todayLosses = openSignals.filter(
    s => s.status === SignalStatus.LOSS && s.closedAt && s.closedAt >= todayTs
  ).length;

  if (todayLosses >= config.maxDailyLosses) {
    reasons.push(`Max pertes journalières atteint (${todayLosses}/${config.maxDailyLosses})`);
    rejected = true;
  }

  // 3. Corrélation avec positions existantes
  let correlationWarning = false;
  const symbol = candidate.asset.symbol;
  const symbolGroups = Object.entries(CORRELATION_GROUPS)
    .filter(([_, symbols]) => symbols.includes(symbol))
    .map(([group]) => group);

  let correlatedCount = 0;
  for (const pos of openPositions) {
    const posGroups = Object.entries(CORRELATION_GROUPS)
      .filter(([_, symbols]) => symbols.includes(pos.asset))
      .map(([group]) => group);

    if (symbolGroups.some(g => posGroups.includes(g))) {
      correlatedCount++;
    }
  }

  if (correlatedCount >= config.maxCorrelatedPositions) {
    reasons.push(`Trop de positions corrélées (${correlatedCount} dans le même groupe)`);
    multiplier *= 0.5;
    correlationWarning = true;
  }

  // 4. Score technique faible → réduire la taille
  if (technical.score < 50) {
    reasons.push(`Score technique moyen (${technical.score}/100)`);
    multiplier *= 0.7;
  }

  // 5. Alerte macro → réduire ou rejeter
  if (macro.alertLevel === 'RED') {
    reasons.push(`Alerte macro ROUGE: ${macro.events[0] || 'événement majeur'}`);
    multiplier *= 0.3;
  } else if (macro.alertLevel === 'YELLOW') {
    reasons.push(`Alerte macro JAUNE: prudence`);
    multiplier *= 0.7;
  }

  // 6. Direction macro vs technique en conflit
  if (
    macro.bias !== 'NEUTRAL' &&
    technical.direction !== 'NEUTRAL' &&
    ((macro.bias === 'BULLISH' && technical.direction === 'SELL') ||
     (macro.bias === 'BEARISH' && technical.direction === 'BUY'))
  ) {
    reasons.push('Conflit macro/technique: direction opposée');
    multiplier *= 0.5;
  }

  // 7. Volatilité excessive (ATR très élevé par rapport au prix)
  const atrPercent = (candidate.h1Indicators.atr / candidate.price) * 100;
  if (atrPercent > 3) {
    reasons.push(`Volatilité extrême (ATR ${atrPercent.toFixed(1)}% du prix)`);
    multiplier *= 0.6;
  }

  const status = rejected ? 'REJECTED' : multiplier < 0.5 ? 'REDUCED' : 'APPROVED';
  const maxRisk = config.maxRiskPerTrade * multiplier;

  if (reasons.length === 0) {
    reasons.push('Tous les critères de risque OK');
  }

  return {
    status,
    maxRiskPercent: Math.max(0.1, maxRisk),
    positionSizeMultiplier: Math.max(0, Math.min(1, multiplier)),
    reasons,
    correlationWarning,
    maxOpenPositions: config.maxOpenPositions,
  };
}
