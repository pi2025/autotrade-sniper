/**
 * Agent 1 : Screener Technique
 * Pré-filtre rapide sur données H1 — identifie les candidats potentiels.
 * Filtrage LARGE (pas de cascade bloquante) pour maximiser les opportunités.
 * Coût : $0 (calcul pur, pas d'IA)
 */

import { calculateIndicators, STRATEGIES } from '../marketEngine.ts';
import { AssetConfig, StrategyParams, TechnicalIndicators } from '../../types.ts';

export interface ScreenerCandidate {
  asset: AssetConfig;
  h1Indicators: TechnicalIndicators;
  m15Indicators: TechnicalIndicators | null;
  price: number;
  h1Data: { history: number[]; highs: number[]; lows: number[]; opens: number[]; volumes: number[] };
  m15Data: { history: number[]; highs: number[]; lows: number[]; opens: number[]; volumes: number[] };
  screenScore: number;     // Score de pré-sélection 0-100
  screenReason: string;    // Pourquoi ce candidat a passé le screener
}

export interface ScreenerResult {
  candidates: ScreenerCandidate[];
  rejected: { symbol: string; reason: string }[];
  totalScanned: number;
}

export function runScreener(
  assets: AssetConfig[],
  multiTFData: Map<string, { h1: any; m15: any; price: number }>,
  strategy: StrategyParams,
  mutedAssets: Record<string, number>
): ScreenerResult {
  const candidates: ScreenerCandidate[] = [];
  const rejected: { symbol: string; reason: string }[] = [];

  for (const asset of assets) {
    if (!asset.active) continue;

    // Skip muted assets
    const muteExpiry = mutedAssets[asset.symbol];
    if (muteExpiry && muteExpiry > Date.now()) {
      rejected.push({ symbol: asset.symbol, reason: 'Cooldown actif' });
      continue;
    }

    const data = multiTFData.get(asset.symbol);
    if (!data) {
      rejected.push({ symbol: asset.symbol, reason: 'Données indisponibles' });
      continue;
    }

    // Calcul des indicateurs sur H1 (tendance principale)
    const h1Ind = calculateIndicators(
      data.h1.history, data.h1.highs, data.h1.lows, data.h1.opens, data.h1.volumes,
      strategy, asset.symbol
    );

    if (!h1Ind) {
      rejected.push({ symbol: asset.symbol, reason: 'Historique H1 insuffisant' });
      continue;
    }

    // --- FILTRE LARGE (permissif) ---
    // On veut garder un maximum de candidats pour les agents IA

    // ATR doit être > 0 (marché ouvert)
    if (!h1Ind.atr || h1Ind.atr <= 0) {
      rejected.push({ symbol: asset.symbol, reason: 'Marché fermé (ATR=0)' });
      continue;
    }

    // ADX minimum très bas (juste pour éliminer les marchés totalement plats)
    if (h1Ind.adx < 15) {
      rejected.push({ symbol: asset.symbol, reason: `ADX H1 trop faible (${h1Ind.adx.toFixed(1)})` });
      continue;
    }

    // Choppiness max permissif (< 65 au lieu de < 55)
    if (h1Ind.choppiness > 65) {
      rejected.push({ symbol: asset.symbol, reason: `Marché chaotique H1 (Choppiness: ${h1Ind.choppiness.toFixed(1)})` });
      continue;
    }

    // --- SCORE DE PRÉ-SÉLECTION ---
    let score = 30; // base
    score += h1Ind.adx > 25 ? 20 : h1Ind.adx > 20 ? 10 : 0;
    score += h1Ind.adxSlope === 'RISING' ? 15 : 0;
    score += h1Ind.choppiness < 45 ? 15 : h1Ind.choppiness < 55 ? 5 : 0;
    score += h1Ind.bollingerBands.isSqueezing ? 10 : 0;
    score += h1Ind.rsi > 30 && h1Ind.rsi < 70 ? 10 : 0;

    // Direction de la tendance
    const isBullish = data.price > h1Ind.ema50 && h1Ind.ema20 > h1Ind.ema50;
    const isBearish = data.price < h1Ind.ema50 && h1Ind.ema20 < h1Ind.ema50;
    const hasDirection = isBullish || isBearish;
    score += hasDirection ? 10 : 0;

    const reason = [
      `ADX H1: ${h1Ind.adx.toFixed(1)} (${h1Ind.adxSlope})`,
      `Choppiness: ${h1Ind.choppiness.toFixed(1)}`,
      hasDirection ? (isBullish ? 'Tendance BULL' : 'Tendance BEAR') : 'Pas de direction claire',
      h1Ind.bollingerBands.isSqueezing ? 'Squeeze BB détecté' : '',
    ].filter(Boolean).join(' | ');

    // Calcul des indicateurs M15 (pour le timing d'entrée)
    const m15Ind = calculateIndicators(
      data.m15.history, data.m15.highs, data.m15.lows, data.m15.opens, data.m15.volumes,
      strategy, asset.symbol
    );

    candidates.push({
      asset,
      h1Indicators: h1Ind,
      m15Indicators: m15Ind,
      price: data.price,
      h1Data: data.h1,
      m15Data: data.m15,
      screenScore: Math.min(100, score),
      screenReason: reason,
    });
  }

  // Trier par score décroissant, garder les meilleurs
  candidates.sort((a, b) => b.screenScore - a.screenScore);

  return { candidates, rejected, totalScanned: assets.length };
}
