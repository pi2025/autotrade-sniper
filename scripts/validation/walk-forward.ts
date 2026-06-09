#!/usr/bin/env npx tsx
/**
 * scripts/validation/walk-forward.ts — Étape B3
 *
 * Harnais de validation walk-forward sur 2 ans de données H1 (~12 000 barres).
 *
 * Découpage : 6 fenêtres OOS consécutives de 3 mois chacune.
 * Chaque fenêtre utilise les 1 200 barres précédentes comme warmup indicateurs.
 *
 * Simulation de trades :
 *   - Entrée au close de la barre signal
 *   - SL / TP calculés par analyzeMarket (stop ATR × 2.0, TP = 2R)
 *   - Vérification barre par barre : low < SL (BUY) ou high > TP (BUY) ?
 *   - Breakeven : SL déplacé à l'entrée dès que price > entry + 1.5 × riskDist
 *   - Coût : −0.05R par trade (spread + commission)
 *   - Max hold : 120 barres H1 (5 jours de trading)
 *
 * Usage : npx tsx scripts/validation/walk-forward.ts
 * Pré-requis : B1 (données) + B2 (au moins 30 signaux confirmés)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 1200;
const MAX_HOLD   = 120;   // barres H1 max par trade (~5 jours)
const TRADE_COST = 0.05;  // R de frais par trade

interface OHLCVBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; interval: string; bars: OHLCVBar[]; }

// Critères d'arrêt définis le 2026-06-08
const CRITERIA = {
  edgeConfirmedMinExpectancy:  0.10,  // R/trade
  edgeConfirmedMinWindows:     3,     // sur 4 fenêtres OOS
  edgeConfirmedMinPF:          1.30,
  edgeConfirmedMinWinRate:     0.38,
  edgeConfirmedMinTrades:      30,
  abandonMaxNegWindows:        2,     // fenêtres consécutives avec expectancy < 0
  abandonMaxPF:                1.00,
  inconclusiveMinTrades:       15,
};

interface WindowResult {
  label: string;
  fromDate: string;
  toDate: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number; // R/trade
  profitFactor: number;
  maxDrawdown: number;
  netPnL: number;
}

function simulateWindow(
  symbol: string,
  allBars: OHLCVBar[],
  startIdx: number,
  endIdx: number,
): number[] {
  const closes  = allBars.map(b => b.close);
  const highs   = allBars.map(b => b.high);
  const lows    = allBars.map(b => b.low);
  const opens   = allBars.map(b => b.open);
  const volumes = allBars.map(b => b.volume);

  const pnls: number[] = [];
  let inTrade       = false;
  let entryPrice    = 0;
  let stopLoss      = 0;
  let takeProfit    = 0;
  let tradeType     = '';
  let holdCount     = 0;
  let breakevenSet  = false;
  let riskDist      = 0;

  for (let i = startIdx; i < endIdx; i++) {
    if (inTrade) {
      holdCount++;
      const hi = highs[i];
      const lo = lows[i];

      // Breakeven : déplace SL à l'entrée dès 1.5R
      if (!breakevenSet) {
        const gain = tradeType === 'BUY' ? closes[i] - entryPrice : entryPrice - closes[i];
        if (gain >= riskDist * 1.5) {
          stopLoss = entryPrice;
          breakevenSet = true;
        }
      }

      let closed = false;
      let exitPnl = 0;

      if (tradeType === 'BUY') {
        if (lo <= stopLoss) { exitPnl = (stopLoss - entryPrice) / riskDist; closed = true; }
        else if (hi >= takeProfit) { exitPnl = (takeProfit - entryPrice) / riskDist; closed = true; }
      } else {
        if (hi >= stopLoss) { exitPnl = (entryPrice - stopLoss) / riskDist; closed = true; }
        else if (lo <= takeProfit) { exitPnl = (entryPrice - takeProfit) / riskDist; closed = true; }
      }

      if (!closed && holdCount >= MAX_HOLD) {
        exitPnl = tradeType === 'BUY'
          ? (closes[i] - entryPrice) / riskDist
          : (entryPrice - closes[i]) / riskDist;
        closed = true;
      }

      if (closed) {
        pnls.push(exitPnl - TRADE_COST);
        inTrade = false;
      }
    } else {
      // Chercher un signal — fenêtre fixe LOOKBACK barres
      const winStart = Math.max(0, i - LOOKBACK + 1);
      const ind = calculateIndicators(
        closes.slice(winStart, i + 1),
        highs.slice(winStart, i + 1),
        lows.slice(winStart, i + 1),
        opens.slice(winStart, i + 1),
        volumes.slice(winStart, i + 1),
        DEFAULT_STRATEGY,
        symbol,
      );
      if (!ind) continue;

      const { signal } = analyzeMarket(symbol, closes[i], ind, DEFAULT_STRATEGY);
      if (signal && signal.tradeSetup) {
        inTrade      = true;
        entryPrice   = closes[i];
        stopLoss     = signal.tradeSetup.stopLoss;
        takeProfit   = signal.tradeSetup.takeProfit;
        tradeType    = signal.type === SignalType.BUY ? 'BUY' : 'SELL';
        riskDist     = Math.abs(entryPrice - stopLoss);
        holdCount    = 0;
        breakevenSet = false;
      }
    }
  }

  return pnls;
}

function calcMetrics(pnls: number[], label: string, fromDate: string, toDate: string): WindowResult {
  const trades  = pnls.length;
  if (trades === 0) return { label, fromDate, toDate, trades: 0, wins: 0, losses: 0, winRate: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 0, netPnL: 0 };

  const wins    = pnls.filter(p => p > 0).length;
  const losses  = pnls.filter(p => p <= 0).length;
  const winPnl  = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const lossPnl = Math.abs(pnls.filter(p => p <= 0).reduce((s, p) => s + p, 0));
  const netPnL  = pnls.reduce((s, p) => s + p, 0);

  let peak = 0, equity = 0, maxDD = 0;
  for (const p of pnls) { equity += p; if (equity > peak) peak = equity; maxDD = Math.max(maxDD, peak - equity); }

  return {
    label, fromDate, toDate, trades, wins, losses,
    winRate:      trades > 0 ? wins / trades : 0,
    expectancy:   trades > 0 ? netPnL / trades : 0,
    profitFactor: lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0,
    maxDrawdown:  maxDD,
    netPnL,
  };
}

function verdict(windows: WindowResult[], aggregate: WindowResult): string {
  const c = CRITERIA;
  const { trades, expectancy, profitFactor, winRate } = aggregate;

  if (trades < c.inconclusiveMinTrades) return `⚠️  INCONCLUSIVE — ${trades} trades total (seuil : ${c.inconclusiveMinTrades}). Trop sélectif pour conclure.`;
  if (trades < c.edgeConfirmedMinTrades) return `⚠️  INCONCLUSIVE — ${trades} trades (seuil confirmé : ${c.edgeConfirmedMinTrades}).`;

  const negConsec = (() => {
    let max = 0, cur = 0;
    for (const w of windows) { if (w.expectancy < 0) { cur++; max = Math.max(max, cur); } else cur = 0; }
    return max;
  })();

  if (expectancy <= 0) return `❌ ABANDON — Expectancy agrégée négative (${expectancy.toFixed(3)}R/trade).`;
  if (profitFactor < c.abandonMaxPF) return `❌ ABANDON — Profit Factor < 1.0 (${profitFactor.toFixed(2)}).`;
  if (negConsec >= c.abandonMaxNegWindows) return `❌ ABANDON — ${negConsec} fenêtres OOS consécutives avec expectancy < 0.`;

  const passingWindows = windows.filter(w => w.expectancy >= c.edgeConfirmedMinExpectancy).length;
  if (passingWindows >= c.edgeConfirmedMinWindows && profitFactor >= c.edgeConfirmedMinPF && winRate >= c.edgeConfirmedMinWinRate) {
    return `✅ EDGE CONFIRMÉ — Expectancy ${expectancy.toFixed(3)}R/trade | PF ${profitFactor.toFixed(2)} | WR ${(winRate*100).toFixed(0)}% | ${passingWindows}/${windows.length} fenêtres OK.`;
  }

  return `⚠️  EDGE MARGINAL — Expectancy ${expectancy.toFixed(3)}R/trade | PF ${profitFactor.toFixed(2)} | WR ${(winRate*100).toFixed(0)}% | ${passingWindows}/${windows.length} fenêtres OK. Réviser les filtres.`;
}

async function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_1h.json')).sort();
  if (files.length === 0) { console.error('❌ Aucun fichier H1 — lancer B1 d\'abord.'); process.exit(1); }

  // Charger tous les actifs
  const datasets: { symbol: string; bars: OHLCVBar[] }[] = [];
  for (const file of files) {
    const d: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    if (d.bars.length >= LOOKBACK + 100) datasets.push({ symbol: d.symbol, bars: d.bars });
  }

  // Définir 6 fenêtres OOS de 3 mois sur les données disponibles
  const refBars = datasets[0].bars;
  const totalBars = refBars.length;
  const WINDOWS_N = 6;
  const barsPerWindow = Math.floor((totalBars - LOOKBACK) / WINDOWS_N);

  const windowDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({
    label:    `OOS-${w + 1}`,
    startIdx: LOOKBACK + w * barsPerWindow,
    endIdx:   LOOKBACK + (w + 1) * barsPerWindow,
  }));

  console.log(`\n📊 Étape B3 — Walk-forward H1 (${datasets.length} actifs, ${WINDOWS_N} fenêtres OOS)`);
  console.log(`   Stratégie : ${DEFAULT_STRATEGY.name} | Max hold : ${MAX_HOLD}h | Coût : ${TRADE_COST}R/trade\n`);

  const allWindowPnls: number[][] = windowDefs.map(() => []);

  for (const ds of datasets) {
    process.stdout.write(`  ▶ ${ds.symbol.padEnd(12)} `);
    let totalTrades = 0;
    for (let w = 0; w < WINDOWS_N; w++) {
      const { startIdx, endIdx } = windowDefs[w];
      const pnls = simulateWindow(ds.symbol, ds.bars, startIdx, endIdx);
      allWindowPnls[w].push(...pnls);
      totalTrades += pnls.length;
      process.stdout.write(`W${w+1}:${pnls.length} `);
    }
    console.log(`(${totalTrades} trades total)`);
  }

  // Calculer métriques par fenêtre
  const windowResults: WindowResult[] = windowDefs.map((def, w) => {
    const fromDate = new Date(refBars[def.startIdx]?.ts ?? 0).toISOString().slice(0, 10);
    const toDate   = new Date(refBars[def.endIdx - 1]?.ts ?? 0).toISOString().slice(0, 10);
    return calcMetrics(allWindowPnls[w], def.label, fromDate, toDate);
  });

  const allPnls = allWindowPnls.flat();
  const aggResult = calcMetrics(allPnls, 'AGRÉGÉ', windowResults[0]?.fromDate ?? '', windowResults[WINDOWS_N-1]?.toDate ?? '');

  // --- Rapport ---
  console.log('\n\n══════════════════════════════════════════════════════════ Résultats B3 ══');
  console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  for (const r of windowResults) {
    const line = [
      r.label.padEnd(10),
      `${r.fromDate} → ${r.toDate}`.padEnd(25),
      r.trades.toString().padStart(6),
      (r.winRate * 100).toFixed(0).padStart(5) + '%',
      r.expectancy.toFixed(3).padStart(7),
      r.profitFactor.toFixed(2).padStart(6),
      r.maxDrawdown.toFixed(1).padStart(6) + 'R',
    ].join('  ');
    const ok = r.expectancy >= CRITERIA.edgeConfirmedMinExpectancy ? '✅' : r.expectancy < 0 ? '❌' : '⚠️ ';
    console.log(`  ${ok} ${line}`);
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log([
    '  ⭐ AGRÉGÉ   ',
    `${aggResult.fromDate} → ${aggResult.toDate}`.padEnd(25),
    aggResult.trades.toString().padStart(6),
    (aggResult.winRate * 100).toFixed(0).padStart(5) + '%',
    aggResult.expectancy.toFixed(3).padStart(7),
    aggResult.profitFactor.toFixed(2).padStart(6),
    aggResult.maxDrawdown.toFixed(1).padStart(6) + 'R',
  ].join('  '));

  console.log('\n  ─── Verdict final ───────────────────────────────────────────────────────');
  console.log(`  ${verdict(windowResults, aggResult)}`);
  console.log(`\n  Critères appliqués : E ≥ ${CRITERIA.edgeConfirmedMinExpectancy}R sur ≥${CRITERIA.edgeConfirmedMinWindows} fenêtres | PF ≥ ${CRITERIA.edgeConfirmedMinPF} | WR ≥ ${(CRITERIA.edgeConfirmedMinWinRate*100).toFixed(0)}% | min ${CRITERIA.edgeConfirmedMinTrades} trades`);

  // --- Sauvegarde ---
  const out = { generatedAt: Date.now(), strategy: DEFAULT_STRATEGY.name, criteria: CRITERIA, windowResults, aggregate: aggResult, verdictText: verdict(windowResults, aggResult) };
  const outPath = path.join(DATA_DIR, '_b3_walkforward_results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n→ Résultats complets : ${path.basename(outPath)}`);
  console.log('→ Présenter ce verdict au CEO avant toute modification de marketEngine.ts.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
