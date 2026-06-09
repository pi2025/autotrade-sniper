#!/usr/bin/env npx tsx
/**
 * scripts/validation/walk-forward-ctrader.ts
 *
 * Walk-forward identique à walk-forward.ts (B3) mais sur les données
 * cTrader (fichiers *_1h_ctrader.json) — données réelles du broker.
 *
 * Usage : npx tsx scripts/validation/walk-forward-ctrader.ts
 * Pré-requis : fetch-ctrader-history.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK   = 1200;
const MAX_HOLD   = 120;
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;

const CRITERIA = { minExpectancy: 0.10, minWindows: 3, minPF: 1.30, minWR: 0.38, minTrades: 30, abandonNegConsec: 2 };

interface OHLCVBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; interval: string; bars: OHLCVBar[]; }

function simulateWindow(symbol: string, allBars: OHLCVBar[], startIdx: number, endIdx: number): number[] {
  const closes  = allBars.map(b => b.close);
  const highs   = allBars.map(b => b.high);
  const lows    = allBars.map(b => b.low);
  const opens   = allBars.map(b => b.open);
  const volumes = allBars.map(b => b.volume);
  const pnls: number[] = [];
  let inTrade = false, entryPrice = 0, stopLoss = 0, takeProfit = 0;
  let tradeType = '', holdCount = 0, riskDist = 0, breakevenSet = false;

  for (let i = startIdx; i < endIdx; i++) {
    if (inTrade) {
      holdCount++;
      if (!breakevenSet && (tradeType === 'BUY' ? closes[i]-entryPrice : entryPrice-closes[i]) >= riskDist * 1.5) {
        stopLoss = entryPrice; breakevenSet = true;
      }
      let closed = false, exitPnl = 0;
      if (tradeType === 'BUY') {
        if (lows[i] <= stopLoss) { exitPnl = (stopLoss-entryPrice)/riskDist; closed = true; }
        else if (highs[i] >= takeProfit) { exitPnl = (takeProfit-entryPrice)/riskDist; closed = true; }
      } else {
        if (highs[i] >= stopLoss) { exitPnl = (entryPrice-stopLoss)/riskDist; closed = true; }
        else if (lows[i] <= takeProfit) { exitPnl = (entryPrice-takeProfit)/riskDist; closed = true; }
      }
      if (!closed && holdCount >= MAX_HOLD) {
        exitPnl = tradeType === 'BUY' ? (closes[i]-entryPrice)/riskDist : (entryPrice-closes[i])/riskDist;
        closed = true;
      }
      if (closed) { pnls.push(exitPnl - TRADE_COST); inTrade = false; }
    } else {
      const ws = Math.max(0, i - LOOKBACK + 1);
      const ind = calculateIndicators(closes.slice(ws,i+1), highs.slice(ws,i+1), lows.slice(ws,i+1), opens.slice(ws,i+1), volumes.slice(ws,i+1), DEFAULT_STRATEGY, symbol);
      if (!ind) continue;
      const { signal } = analyzeMarket(symbol, closes[i], ind, DEFAULT_STRATEGY);
      if (signal?.tradeSetup) {
        inTrade = true; entryPrice = closes[i]; stopLoss = signal.tradeSetup.stopLoss; takeProfit = signal.tradeSetup.takeProfit;
        tradeType = signal.type === SignalType.BUY ? 'BUY' : 'SELL';
        riskDist = Math.abs(entryPrice - stopLoss); holdCount = 0; breakevenSet = false;
      }
    }
  }
  return pnls;
}

function calcMetrics(pnls: number[], label: string, from: string, to: string) {
  const trades = pnls.length;
  if (!trades) return { label, from, to, trades: 0, winRate: 0, expectancy: 0, profitFactor: 0, maxDD: 0, netPnL: 0 };
  const wins    = pnls.filter(p => p > 0).length;
  const winPnl  = pnls.filter(p => p > 0).reduce((s,p) => s+p, 0);
  const lossPnl = Math.abs(pnls.filter(p => p <= 0).reduce((s,p) => s+p, 0));
  const netPnL  = pnls.reduce((s,p) => s+p, 0);
  let peak = 0, eq = 0, maxDD = 0;
  for (const p of pnls) { eq += p; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, peak-eq); }
  return { label, from, to, trades, winRate: wins/trades, expectancy: netPnL/trades, profitFactor: lossPnl > 0 ? winPnl/lossPnl : winPnl > 0 ? 99 : 0, maxDD, netPnL };
}

async function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_1h_ctrader.json')).sort();
  if (!files.length) { console.error('❌ Aucun fichier cTrader — lancer fetch-ctrader-history.ts d\'abord.'); process.exit(1); }

  const datasets = files.map(f => { const d: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); return { symbol: d.symbol, ctraderName: d.ctraderName, bars: d.bars }; }).filter(d => d.bars.length >= LOOKBACK + 100);

  if (!datasets.length) { console.error('❌ Aucun actif avec suffisamment de données (min ' + (LOOKBACK+100) + ' barres).'); process.exit(1); }

  const refBars = datasets[0].bars;
  const barsPerWin = Math.floor((refBars.length - LOOKBACK) / WINDOWS_N);
  const winDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({ label: `OOS-${w+1}`, startIdx: LOOKBACK + w * barsPerWin, endIdx: LOOKBACK + (w+1) * barsPerWin }));

  console.log(`\n📊 Walk-forward cTrader — 7 filtres | H1 | ${datasets.length} actifs | ${WINDOWS_N} fenêtres (~${barsPerWin} barres/fenêtre)\n`);

  const allWinPnls: number[][] = winDefs.map(() => []);
  for (const ds of datasets) {
    process.stdout.write(`  ▶ ${ds.ctraderName.padEnd(8)} `);
    for (let w = 0; w < WINDOWS_N; w++) {
      const pnls = simulateWindow(ds.symbol, ds.bars, winDefs[w].startIdx, winDefs[w].endIdx);
      allWinPnls[w].push(...pnls);
      process.stdout.write(`W${w+1}:${pnls.length} `);
    }
    console.log();
  }

  const results = winDefs.map((def, w) => calcMetrics(allWinPnls[w], def.label,
    new Date(refBars[def.startIdx]?.ts ?? 0).toISOString().slice(0,10),
    new Date(refBars[def.endIdx-1]?.ts ?? 0).toISOString().slice(0,10)));
  const agg = calcMetrics(allWinPnls.flat(), 'AGRÉGÉ', results[0]?.from ?? '', results[WINDOWS_N-1]?.to ?? '');

  console.log('\n══════════════════════════════════════ Walk-forward cTrader (données broker) ══');
  console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  for (const r of results) {
    const icon = r.expectancy >= CRITERIA.minExpectancy ? '✅' : r.expectancy < 0 ? '❌' : '⚠️ ';
    console.log(`  ${icon} ${r.label.padEnd(10)} ${`${r.from} → ${r.to}`.padEnd(25)} ${r.trades.toString().padStart(6)}  ${(r.winRate*100).toFixed(0).padStart(4)}%  ${r.expectancy.toFixed(3).padStart(7)}  ${r.profitFactor.toFixed(2).padStart(5)}  ${r.maxDD.toFixed(1).padStart(5)}R`);
  }
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  console.log(`  ⭐ ${agg.label.padEnd(10)} ${`${agg.from} → ${agg.to}`.padEnd(25)} ${agg.trades.toString().padStart(6)}  ${(agg.winRate*100).toFixed(0).padStart(4)}%  ${agg.expectancy.toFixed(3).padStart(7)}  ${agg.profitFactor.toFixed(2).padStart(5)}  ${agg.maxDD.toFixed(1).padStart(5)}R`);

  const passing = results.filter(r => r.expectancy >= CRITERIA.minExpectancy).length;
  const negConsec = (() => { let m=0,c=0; for(const r of results){if(r.expectancy<0){c++;m=Math.max(m,c);}else c=0;} return m; })();
  let verdict = '';
  if (agg.trades < CRITERIA.minTrades) verdict = `⚠️  INCONCLUSIVE — ${agg.trades} trades (seuil : ${CRITERIA.minTrades})`;
  else if (agg.expectancy <= 0 || negConsec >= CRITERIA.abandonNegConsec) verdict = `❌ ABANDON — E=${agg.expectancy.toFixed(3)}R, ${negConsec} fenêtres négatives consécutives`;
  else if (passing >= CRITERIA.minWindows && agg.profitFactor >= CRITERIA.minPF && agg.winRate >= CRITERIA.minWR) verdict = `✅ EDGE CONFIRMÉ — E=${agg.expectancy.toFixed(3)}R/trade | PF=${agg.profitFactor.toFixed(2)} | WR=${(agg.winRate*100).toFixed(0)}%`;
  else verdict = `⚠️  EDGE MARGINAL — E=${agg.expectancy.toFixed(3)}R | PF=${agg.profitFactor.toFixed(2)} | ${passing}/${WINDOWS_N} fenêtres OK`;

  console.log(`\n  Verdict (données broker) : ${verdict}`);
  console.log('\n→ Ce verdict sur données cTrader est la référence définitive — pas Yahoo Finance.');
  console.log('→ Présenter au CEO avant toute décision sur marketEngine.ts.\n');

  fs.writeFileSync(path.join(DATA_DIR, '_ctrader_walkforward_results.json'), JSON.stringify({ generatedAt: Date.now(), source: 'ctrader', strategy: DEFAULT_STRATEGY.name, criteria: CRITERIA, results, aggregate: agg, verdict }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
