#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-atr-filter.ts
 *
 * Test Option A : filtre régime ATR.
 * Hypothèse : les faux breakouts en OOS-5/6 sont précédés d'un spike ATR
 * (choc macro Trump/tarifs). Bloquer les entrées quand l'ATR courant
 * dépasse le Pème percentile de son propre historique sur ATR_LOOKBACK barres.
 *
 * Grid sur le seuil percentile : 60 / 65 / 70 / 75 / 80
 * Comparaison vs baseline (sans filtre).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK      = 400;
const MAX_HOLD      = 30;
const TRADE_COST    = 0.05;
const WINDOWS_N     = 6;
const ATR_HIST_BARS = 200; // historique ATR pour le percentile (200 barres H4 ≈ 33 jours)

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; bars: Bar[]; }

// ATR 14 période sur un tableau de barres se terminant à l'index idx
function computeATR14(bars: Bar[], idx: number): number {
  if (idx < 14) return 0;
  let sum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const hl = bars[i].high - bars[i].low;
    const hc = i > 0 ? Math.abs(bars[i].high - bars[i-1].close) : hl;
    const lc = i > 0 ? Math.abs(bars[i].low  - bars[i-1].close) : hl;
    sum += Math.max(hl, hc, lc);
  }
  return sum / 14;
}

// Percentile p (0-100) d'un tableau de valeurs
function percentile(values: number[], p: number): number {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// Pré-calcule l'ATR14 pour toutes les barres d'un dataset (coûteux une seule fois)
function buildATRSeries(bars: Bar[]): Float64Array {
  const result = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) result[i] = computeATR14(bars, i);
  return result;
}

// Renvoie vrai si la barre est dans un régime de haute volatilité
function isHighVolatilityRegime(atrSeries: Float64Array, idx: number, pThreshold: number): boolean {
  const histStart = Math.max(0, idx - ATR_HIST_BARS);
  const history: number[] = [];
  for (let i = histStart; i < idx; i++) if (atrSeries[i] > 0) history.push(atrSeries[i]);
  if (history.length < 30) return false; // pas assez d'historique → ne pas filtrer
  const p = percentile(history, pThreshold);
  return atrSeries[idx] > p;
}

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4'); process.exit(1); }

const datasets = files.map(f => {
  const d: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return { symbol: d.symbol, name: d.ctraderName, bars: d.bars, atr: buildATRSeries(d.bars) };
}).filter(d => d.bars.length >= LOOKBACK + 100);

const ref = datasets[0].bars;
const bpw = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const winDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({
  label: `OOS-${w+1}`,
  from: new Date(ref[LOOKBACK + w * bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK + (w+1)*bpw - 1]?.ts ?? 0).toISOString().slice(0,10),
  s: LOOKBACK + w * bpw,
  e: LOOKBACK + (w+1) * bpw,
}));

function simulate(ds: typeof datasets[0], start: number, end: number, pThreshold: number | null): number[] {
  const { symbol, bars, atr } = ds;
  const closes = bars.map(b=>b.close), highs = bars.map(b=>b.high), lows = bars.map(b=>b.low), opens = bars.map(b=>b.open), vols = bars.map(b=>b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, tp=0, type='', hold=0, risk=0, be=false;

  for (let i=start; i<end; i++) {
    if (inTrade) {
      hold++;
      if (!be && (type==='BUY'?closes[i]-entry:entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }
      let closed=false, pnl=0;
      if (type==='BUY') { if(lows[i]<=sl){pnl=(sl-entry)/risk;closed=true;} else if(highs[i]>=tp){pnl=(tp-entry)/risk;closed=true;} }
      else              { if(highs[i]>=sl){pnl=(entry-sl)/risk;closed=true;} else if(lows[i]<=tp){pnl=(entry-tp)/risk;closed=true;} }
      if (!closed && hold>=MAX_HOLD) { pnl=type==='BUY'?(closes[i]-entry)/risk:(entry-closes[i])/risk; closed=true; }
      if (closed) { if (!isNaN(pnl)) pnls.push(pnl-TRADE_COST); inTrade=false; }
    } else {
      // Filtre régime ATR — si activé et haute volatilité → pas d'entrée
      if (pThreshold !== null && isHighVolatilityRegime(atr, i, pThreshold)) continue;

      const ws = Math.max(0, i - LOOKBACK + 1);
      const ind = calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),DEFAULT_STRATEGY,symbol);
      if (!ind) continue;
      const { signal } = analyzeMarket(symbol, closes[i], ind, DEFAULT_STRATEGY);
      if (signal?.tradeSetup) {
        const r = Math.abs(closes[i] - signal.tradeSetup.stopLoss);
        if (r <= 0) continue;
        inTrade=true; entry=closes[i]; sl=signal.tradeSetup.stopLoss; tp=signal.tradeSetup.takeProfit;
        type=signal.type===SignalType.BUY?'BUY':'SELL'; risk=r; hold=0; be=false;
      }
    }
  }
  return pnls;
}

function metrics(pnls: number[]) {
  const n=pnls.length; if(!n) return {n:0,wr:0,e:0,pf:0,dd:0};
  const wins=pnls.filter(p=>p>0).length;
  const wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0);
  const lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0));
  const net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0; for(const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return {n,wr:wins/n,e:net/n,pf:lp>0?wp/lp:wp>0?99:0,dd};
}

function negConsec(winMetrics: ReturnType<typeof metrics>[]) {
  let m=0,c=0;
  for(const wm of winMetrics){if(wm.e<0){c++;m=Math.max(m,c);}else c=0;}
  return m;
}

const THRESHOLDS: Array<number | null> = [null, 60, 65, 70, 75, 80];

console.log('\n📊 Walk-forward H4 — Test filtre régime ATR\n');

type RunResult = {
  label: string;
  agg: ReturnType<typeof metrics>;
  byWin: ReturnType<typeof metrics>[];
  negC: number;
};
const allRuns: RunResult[] = [];

for (const pThresh of THRESHOLDS) {
  const allWinPnls: number[][] = winDefs.map(()=>[]);
  for (const ds of datasets)
    for (let w=0;w<WINDOWS_N;w++)
      allWinPnls[w].push(...simulate(ds, winDefs[w].s, winDefs[w].e, pThresh));
  const byWin = allWinPnls.map(p => metrics(p));
  const agg = metrics(allWinPnls.flat());
  const label = pThresh === null ? 'BASELINE (sans filtre)' : `ATR filtre P${pThresh}       `;
  allRuns.push({ label, agg, byWin, negC: negConsec(byWin) });
}

// Tableau récap
const p = (s: string|number, w=8) => String(s).padStart(w);
console.log(`  Config                  Trades  WR%    E(R)    PF    MaxDD  OOS5-E  OOS6-E  NegCons  Verdict`);
console.log('  ' + '─'.repeat(100));

for (const r of allRuns) {
  const oos5 = r.byWin[4], oos6 = r.byWin[5];
  const v = r.agg.n < 30 ? '⚠️  INCONCLUSIVE' : r.agg.e <= 0 || r.negC >= 2 ? '❌ ABANDON' : r.agg.e >= 0.10 && r.agg.pf >= 1.30 && r.agg.wr >= 0.38 ? '✅ EDGE CONFIRMÉ' : '⚠️  MARGINAL';
  const isBaseline = r.label.includes('BASELINE');
  const tag = isBaseline ? ' ←' : '  ';
  console.log(`  ${r.label}${tag} ${p(r.agg.n,6)}  ${p((r.agg.wr*100).toFixed(0)+'%',4)}  ${p(r.agg.e.toFixed(3),7)}  ${p(r.agg.pf.toFixed(2),5)}  ${p(r.agg.dd.toFixed(1)+'R',6)}  ${p(oos5.e.toFixed(3),7)} ${p(oos6.e.toFixed(3),7)}  ${p(r.negC,5)}    ${v}`);
}

// Meilleure config : max E(R) avec assez de trades
const best = allRuns.filter(r => r.agg.n >= 30).sort((a,b) => b.agg.e - a.agg.e)[0];
const baseline = allRuns[0];
console.log(`\n→ Meilleure config : ${best.label.trim()}`);
console.log(`  E(R):  ${baseline.agg.e.toFixed(3)} → ${best.agg.e.toFixed(3)}  (${best.agg.e >= baseline.agg.e ? '+' : ''}${(best.agg.e - baseline.agg.e).toFixed(3)}R)`);
console.log(`  Trades: ${baseline.agg.n} → ${best.agg.n}  (filtrés : ${baseline.agg.n - best.agg.n})`);
console.log(`  NegConsec: ${baseline.negC} → ${best.negC}`);

// Fenêtre par fenêtre pour la meilleure config
if (best.label !== baseline.label) {
  console.log(`\n📋 Détail OOS — ${best.label.trim()}\n`);
  console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF');
  console.log('  ' + '─'.repeat(70));
  for (let w=0;w<WINDOWS_N;w++) {
    const m=best.byWin[w];
    const ic=m.e>=0.10?'✅':m.e<0?'❌':'⚠️ ';
    console.log(`  ${ic} ${winDefs[w].label.padEnd(10)} ${`${winDefs[w].from} → ${winDefs[w].to}`.padEnd(25)} ${p(m.n,5)}  ${p((m.wr*100).toFixed(0)+'%',4)}  ${p(m.e.toFixed(3),7)}  ${p(m.pf.toFixed(2),5)}`);
  }
}

// % de barres filtrées par régime en OOS-5/6
console.log('\n📈 Barres bloquées par filtre ATR — OOS-5 et OOS-6\n');
for (const pThresh of THRESHOLDS.filter(p => p !== null) as number[]) {
  let blockedOos5=0, totalOos5=0, blockedOos6=0, totalOos6=0;
  for (const ds of datasets) {
    for (let i=winDefs[4].s; i<winDefs[4].e; i++) { totalOos5++; if(isHighVolatilityRegime(ds.atr,i,pThresh)) blockedOos5++; }
    for (let i=winDefs[5].s; i<winDefs[5].e; i++) { totalOos6++; if(isHighVolatilityRegime(ds.atr,i,pThresh)) blockedOos6++; }
  }
  const pct5=(blockedOos5/totalOos5*100).toFixed(1), pct6=(blockedOos6/totalOos6*100).toFixed(1);
  console.log(`  P${pThresh}  →  OOS-5: ${blockedOos5.toString().padStart(5)} barres bloquées / ${totalOos5} (${pct5}%)   OOS-6: ${blockedOos6.toString().padStart(5)} / ${totalOos6} (${pct6}%)`);
}

fs.writeFileSync(path.join(DATA_DIR,'_atr_filter_h4.json'), JSON.stringify({generatedAt:Date.now(), runs:allRuns.map(r=>({label:r.label,...r.agg,oos5:r.byWin[4],oos6:r.byWin[5],negConsec:r.negC}))}, null, 2));
console.log('\n→ Résultats sauvegardés : data/_atr_filter_h4.json\n');
