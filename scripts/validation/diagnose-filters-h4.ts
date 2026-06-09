#!/usr/bin/env npx tsx
/**
 * diagnose-filters-h4.ts
 *
 * Diagnostic : pour chaque fenêtre OOS, compte combien de barres H4
 * sont rejetées par chaque filtre de analyzeMarket() — AVANT le breakout Donchian.
 *
 * Objectif : identifier quel filtre est responsable de la basse fréquence
 * et de la dégradation en OOS-5/6 (Nov2024 → Jun2026).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK   = 400;
const WINDOWS_N  = 6;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; bars: Bar[]; }

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4 — lancer fetch-ctrader-h4.ts'); process.exit(1); }

const datasets = files.map(f => {
  const d: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return { symbol: d.symbol, name: d.ctraderName, bars: d.bars };
}).filter(d => d.bars.length >= LOOKBACK + 100);

const ref = datasets[0].bars;
const bpw = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const winDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({
  label: `OOS-${w+1}`,
  start: LOOKBACK + w * bpw,
  end:   LOOKBACK + (w+1) * bpw,
  from: new Date(ref[LOOKBACK + w * bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK + (w+1)*bpw - 1]?.ts ?? 0).toISOString().slice(0,10),
}));

// Noms des filtres dans l'ordre d'évaluation
type FilterName = 'MTF_ALIGN' | 'CHOPPINESS' | 'ADX_STRENGTH' | 'ADX_RISING' | 'FAN_WIDENING' | 'RSI_EXTREME' | 'DONCHIAN_BREAKOUT' | 'SIGNAL_FIRED';

const FILTER_NAMES: FilterName[] = [
  'MTF_ALIGN', 'CHOPPINESS', 'ADX_STRENGTH', 'ADX_RISING',
  'FAN_WIDENING', 'RSI_EXTREME', 'DONCHIAN_BREAKOUT', 'SIGNAL_FIRED',
];

function diagnoseBar(symbol: string, bars: Bar[], i: number): FilterName {
  const ws = Math.max(0, i - LOOKBACK + 1);
  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const opens   = bars.map(b => b.open);
  const volumes = bars.map(b => b.volume);

  const ind = calculateIndicators(
    closes.slice(ws, i+1), highs.slice(ws, i+1), lows.slice(ws, i+1),
    opens.slice(ws, i+1), volumes.slice(ws, i+1), DEFAULT_STRATEGY, symbol
  );
  if (!ind) return 'MTF_ALIGN'; // pas assez de données

  const price = closes[i];
  const indAny = ind as any;

  // Reproduire exactement les guards de analyzeMarket()
  const mtfOk       = ind.mtfAlignment?.isAligned;
  const isNotChoppy = ind.choppiness < 55;
  const isAdxStrong = ind.adx >= DEFAULT_STRATEGY.adxThreshold;
  const isAdxRising = ind.adxSlope === 'RISING';
  const isWidening  = indAny.isWidening;
  const rsiOk       = !(ind.rsi > 72 || ind.rsi < 28);

  if (!mtfOk)       return 'MTF_ALIGN';
  if (!isNotChoppy) return 'CHOPPINESS';
  if (!isAdxStrong) return 'ADX_STRENGTH';
  if (!isAdxRising) return 'ADX_RISING';
  if (!isWidening)  return 'FAN_WIDENING';
  if (!rsiOk)       return 'RSI_EXTREME';

  // Donchian breakout + Triple Fan
  const isBullFan = price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
  const isBearFan = price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;
  const buffer = ind.atr * 0.15;
  const isBullBreak = price > (ind.donchian.upper + buffer) && isBullFan;
  const isBearBreak = price < (ind.donchian.lower - buffer) && isBearFan;

  if (!isBullBreak && !isBearBreak) return 'DONCHIAN_BREAKOUT';
  return 'SIGNAL_FIRED';
}

console.log('\n🔬 Diagnostic Filtres H4 — Rejections par filtre par fenêtre OOS\n');

// Structure: winIdx → filterName → count
const winStats: Array<Record<FilterName, number>> = winDefs.map(() =>
  Object.fromEntries(FILTER_NAMES.map(n => [n, 0])) as Record<FilterName, number>
);
const winTotals = winDefs.map(() => 0);

for (const ds of datasets) {
  for (let w = 0; w < WINDOWS_N; w++) {
    for (let i = winDefs[w].start; i < winDefs[w].end; i++) {
      const rejected = diagnoseBar(ds.symbol, ds.bars, i);
      winStats[w][rejected]++;
      winTotals[w]++;
    }
  }
}

// Affichage tableau
const COL = 12;
const pad = (s: string | number, n = COL) => String(s).padStart(n);
const pctOf = (n: number, total: number) => total > 0 ? ((n/total)*100).toFixed(1)+'%' : '0%';

console.log('  Filtre rejetant' + winDefs.map(d => pad(d.label)).join(''));
console.log('  ' + '─'.repeat(16 + WINDOWS_N * COL));

for (const name of FILTER_NAMES) {
  const isSignal = name === 'SIGNAL_FIRED';
  const label = (isSignal ? '→ SIGNAL_FIRED' : name).padEnd(16);
  const counts = winStats.map((ws, w) => {
    const n = ws[name];
    return pad(`${n}(${pctOf(n, winTotals[w])})`);
  }).join('');
  console.log(`  ${label}${counts}`);
}
console.log('  ' + '─'.repeat(16 + WINDOWS_N * COL));
console.log('  ' + 'TOTAL BARS'.padEnd(16) + winTotals.map(t => pad(t)).join(''));
console.log('  ' + 'PÉRIODE'.padEnd(16) + winDefs.map(d => pad(d.from.slice(0,7)+'…')).join(''));

// Zoom sur les 2 dernières fenêtres (OOS-5, OOS-6)
console.log('\n📋 Zoom OOS-5 / OOS-6 — comparaison avec OOS-3 (meilleure fenêtre)\n');
const oos3 = winStats[2], oos5 = winStats[4], oos6 = winStats[5];
const t3 = winTotals[2], t5 = winTotals[4], t6 = winTotals[5];

console.log('  Filtre          OOS-3 (bon)      OOS-5 (mauvais)  OOS-6 (récent)');
console.log('  ' + '─'.repeat(66));
for (const name of FILTER_NAMES) {
  const row = (ws: Record<FilterName,number>, total: number) =>
    `${ws[name].toString().padStart(5)} (${pctOf(ws[name], total).padStart(5)})`;
  console.log(`  ${name.padEnd(16)} ${row(oos3,t3).padEnd(18)} ${row(oos5,t5).padEnd(18)} ${row(oos6,t6)}`);
}

// ADX stats pour comprendre le régime
console.log('\n📈 Stats ADX par fenêtre (avg, % > 22, % rising)\n');
for (const ds of datasets.slice(0,1)) { // Premier actif comme référence
  for (let w = 0; w < WINDOWS_N; w++) {
    const adxVals: number[] = [];
    const risingCount = { n: 0 };
    for (let i = winDefs[w].start; i < winDefs[w].end; i++) {
      const ws = Math.max(0, i - LOOKBACK + 1);
      const closes = ds.bars.map(b=>b.close);
      const highs  = ds.bars.map(b=>b.high);
      const lows   = ds.bars.map(b=>b.low);
      const opens  = ds.bars.map(b=>b.open);
      const vols   = ds.bars.map(b=>b.volume);
      const ind = calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),DEFAULT_STRATEGY,ds.symbol);
      if (!ind) continue;
      adxVals.push(ind.adx);
      if (ind.adxSlope === 'RISING') risingCount.n++;
    }
    const avg = adxVals.length ? adxVals.reduce((a,b)=>a+b,0)/adxVals.length : 0;
    const aboveThresh = adxVals.filter(v=>v>=22).length;
    console.log(`  ${winDefs[w].label} (${winDefs[w].from}→${winDefs[w].to})  ADX moy=${avg.toFixed(1).padStart(5)}  >22: ${pctOf(aboveThresh,adxVals.length).padStart(5)}  rising: ${pctOf(risingCount.n,adxVals.length).padStart(5)}`);
  }
}

console.log('\n→ Le filtre avec le plus fort % de rejections en OOS-5/6 est le candidat #1.\n');
