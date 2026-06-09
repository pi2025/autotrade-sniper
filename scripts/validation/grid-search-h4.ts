#!/usr/bin/env npx tsx
/**
 * grid-search-h4.ts
 *
 * Hypothèse à tester : le TP à 4× ATR (SL 2.0 × R:R 2.0) est trop loin
 * pour le régime post-Nov2024 (faux breakouts, renversements rapides).
 *
 * Grid : SL multiplier {1.5, 1.8, 2.0} × R:R {1.5, 2.0}
 * Une seule variable change à la fois — tout le reste est identique.
 *
 * Verdict par config : agrégé + focus OOS-5/6.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK   = 400;
const MAX_HOLD   = 30;
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; bars: Bar[]; }

const GRID = [
  { slMult: 1.5, rr: 1.5, label: 'SL1.5×RR1.5 → TP=2.25ATR' },
  { slMult: 1.5, rr: 2.0, label: 'SL1.5×RR2.0 → TP=3.0ATR ' },
  { slMult: 1.8, rr: 1.5, label: 'SL1.8×RR1.5 → TP=2.7ATR ' },
  { slMult: 1.8, rr: 2.0, label: 'SL1.8×RR2.0 → TP=3.6ATR ' },
  { slMult: 2.0, rr: 1.5, label: 'SL2.0×RR1.5 → TP=3.0ATR ' },
  { slMult: 2.0, rr: 2.0, label: 'SL2.0×RR2.0 → TP=4.0ATR  ← ACTUEL' },
];

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4'); process.exit(1); }

const datasets = files.map(f => {
  const d: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return { symbol: d.symbol, name: d.ctraderName, bars: d.bars };
}).filter(d => d.bars.length >= LOOKBACK + 100);

const ref = datasets[0].bars;
const bpw = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const winDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({
  label: `OOS-${w+1}`,
  from:  new Date(ref[LOOKBACK + w * bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:    new Date(ref[LOOKBACK + (w+1)*bpw - 1]?.ts ?? 0).toISOString().slice(0,10),
  s: LOOKBACK + w * bpw,
  e: LOOKBACK + (w+1) * bpw,
}));

function simulate(symbol: string, bars: Bar[], start: number, end: number, slMult: number, rr: number): number[] {
  const closes = bars.map(b=>b.close), highs = bars.map(b=>b.high), lows = bars.map(b=>b.low), opens = bars.map(b=>b.open), vols = bars.map(b=>b.volume);
  const strategy = { ...DEFAULT_STRATEGY, stopLossAtrMultiplier: slMult };
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
      const ws=Math.max(0,i-LOOKBACK+1);
      const ind=calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),strategy,symbol);
      if (!ind) continue;
      const { signal } = analyzeMarket(symbol, closes[i], ind, strategy);
      if (signal?.tradeSetup) {
        const r = Math.abs(closes[i] - signal.tradeSetup.stopLoss);
        if (r <= 0) continue;
        // Recalculer TP avec le R:R du grid (analyzeMarket fixe toujours 2R)
        const tpPrice = signal.type === SignalType.BUY ? closes[i] + r*rr : closes[i] - r*rr;
        inTrade=true; entry=closes[i]; sl=signal.tradeSetup.stopLoss; tp=tpPrice;
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

console.log('\n📊 Grid Search H4 — impact SL multiplier × R:R sur l\'edge\n');

const results: Array<{
  config: typeof GRID[0];
  agg: ReturnType<typeof metrics>;
  oos5: ReturnType<typeof metrics>;
  oos6: ReturnType<typeof metrics>;
  winCounts: number[];
  negConsec: number;
}> = [];

for (const cfg of GRID) {
  const allWinPnls: number[][] = winDefs.map(() => []);
  for (const ds of datasets) {
    for (let w=0; w<WINDOWS_N; w++) {
      const p = simulate(ds.symbol, ds.bars, winDefs[w].s, winDefs[w].e, cfg.slMult, cfg.rr);
      allWinPnls[w].push(...p);
    }
  }
  const winMetrics = allWinPnls.map(p => metrics(p));
  const agg = metrics(allWinPnls.flat());
  const neg = (() => { let m=0,c=0; for(const wm of winMetrics){if(wm.e<0){c++;m=Math.max(m,c);}else c=0;} return m; })();
  results.push({
    config: cfg,
    agg,
    oos5: winMetrics[4],
    oos6: winMetrics[5],
    winCounts: winMetrics.map(wm=>wm.n),
    negConsec: neg,
  });
}

// Tableau récap
const p = (s: string|number, w=8) => String(s).padStart(w);
console.log(`  Config                         Trades  WR%    E(R)    PF    MaxDD  OOS5-E  OOS6-E  NegCons  Verdict`);
console.log('  ' + '─'.repeat(112));
for (const r of results) {
  const isBaseline = r.config.slMult === 2.0 && r.config.rr === 2.0;
  const v = r.agg.n < 30 ? '⚠️  INCONCLUSIVE' : r.agg.e <= 0 || r.negConsec >= 2 ? '❌ ABANDON' : r.agg.e >= 0.10 && r.agg.pf >= 1.30 && r.agg.wr >= 0.38 ? '✅ EDGE CONFIRMÉ' : '⚠️  MARGINAL';
  const baseline = isBaseline ? ' ←' : '  ';
  console.log(`  ${r.config.label}${baseline} ${p(r.agg.n,6)}  ${p((r.agg.wr*100).toFixed(0)+'%',4)}  ${p(r.agg.e.toFixed(3),7)}  ${p(r.agg.pf.toFixed(2),5)}  ${p(r.agg.dd.toFixed(1)+'R',6)}  ${p(r.oos5.e.toFixed(3),7)} ${p(r.oos6.e.toFixed(3),7)}  ${p(r.negConsec,5)}    ${v}`);
}

// Meilleure config
const best = results.filter(r => r.agg.n >= 30).sort((a,b) => b.agg.e - a.agg.e)[0];
console.log(`\n→ Meilleure config : ${best.config.label.trim()} — E=${best.agg.e.toFixed(3)}R/trade | PF=${best.agg.pf.toFixed(2)} | WR=${(best.agg.wr*100).toFixed(0)}%`);

// Fenêtre par fenêtre pour la meilleure config
console.log(`\n📋 Détail fenêtre par fenêtre — meilleure config (${best.config.label.trim()})\n`);
const allWinPnls2: number[][] = winDefs.map(()=>[]);
for (const ds of datasets)
  for (let w=0;w<WINDOWS_N;w++)
    allWinPnls2[w].push(...simulate(ds.symbol,ds.bars,winDefs[w].s,winDefs[w].e,best.config.slMult,best.config.rr));
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF');
console.log('  ' + '─'.repeat(70));
for (let w=0;w<WINDOWS_N;w++) {
  const m=metrics(allWinPnls2[w]);
  const ic=m.e>=0.10?'✅':m.e<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${winDefs[w].label.padEnd(10)} ${`${winDefs[w].from} → ${winDefs[w].to}`.padEnd(25)} ${p(m.n,5)}  ${p((m.wr*100).toFixed(0)+'%',4)}  ${p(m.e.toFixed(3),7)}  ${p(m.pf.toFixed(2),5)}`);
}

// Sauvegarde
fs.writeFileSync(path.join(DATA_DIR, '_grid_search_h4.json'), JSON.stringify({ generatedAt: Date.now(), grid: results.map(r=>({...r.config,...r.agg,oos5:r.oos5,oos6:r.oos6})), best: best.config }, null, 2));
console.log('\n→ Résultats sauvegardés : data/_grid_search_h4.json\n');
