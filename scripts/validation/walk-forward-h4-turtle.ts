#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-turtle.ts
 *
 * Turtle Trading System 2 adapté H4 cTrader.
 * Différence clé vs V15 : exit sur contre-cassage Donchian (pas de TP fixe).
 *
 * Logique :
 *   ENTRÉE  : cassage Donchian(N_ENTRY) + filtres V15 (ADX, fan, MTF, choppiness)
 *   EXIT    : prix franchit le Donchian(N_EXIT) côté opposé OU SL OU MAX_HOLD
 *   SL      : 2.0 ATR (inchangé)
 *   PAS DE TP FIXE — laisser courir le trade jusqu'au retournement confirmé
 *
 * Grid : N_ENTRY × N_EXIT → (24×10), (36×12), (48×16), (55×20)
 * Comparaison vs V15 baseline (24 entrée, TP fixe 2R).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 400;
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;
const SL_MULT    = 2.0;
const MAX_HOLD   = 60; // 60 barres H4 = 10 jours max (sans TP fixe, on attend le retournement)

const CRITERIA = { minExpectancy:0.10, minWindows:3, minPF:1.30, minWR:0.38, minTrades:30, abandonNegConsec:2 };

interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number; }
interface Dataset { symbol:string; name:string; bars:Bar[]; }

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4'); process.exit(1); }

const datasets: Dataset[] = files.map(f => {
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return { symbol: d.symbol, name: d.ctraderName, bars: d.bars };
}).filter(d => d.bars.length >= LOOKBACK + 100);

const ref = datasets[0].bars;
const bpw = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const winDefs = Array.from({ length: WINDOWS_N }, (_, w) => ({
  label: `OOS-${w+1}`,
  from: new Date(ref[LOOKBACK + w*bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK + (w+1)*bpw-1]?.ts ?? 0).toISOString().slice(0,10),
  s: LOOKBACK + w*bpw,
  e: LOOKBACK + (w+1)*bpw,
}));

// Donchian channel calculé sur les N barres précédant l'index (pas la barre courante)
function donchianExit(bars: Bar[], idx: number, period: number): { upper: number; lower: number } {
  const start = Math.max(0, idx - period);
  let upper = -Infinity, lower = Infinity;
  for (let i = start; i < idx; i++) {
    if (bars[i].high > upper) upper = bars[i].high;
    if (bars[i].low  < lower) lower = bars[i].low;
  }
  return { upper, lower };
}

function simulate(ds: Dataset, start: number, end: number, nExit: number): number[] {
  const { symbol, bars } = ds;
  const closes = bars.map(b=>b.close), highs = bars.map(b=>b.high),
        lows   = bars.map(b=>b.low),   opens  = bars.map(b=>b.open),
        vols   = bars.map(b=>b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, type='', hold=0, risk=0, be=false;

  const safeEnd = Math.min(end, bars.length);
  for (let i=start; i<safeEnd; i++) {
    if (inTrade) {
      hold++;
      // Breakeven à 1.5R
      if (!be && (type==='BUY'?closes[i]-entry:entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }

      // Exit sur contre-cassage Donchian(nExit)
      const dc = donchianExit(bars, i, nExit);
      let closed=false, pnl=0;
      if (type==='BUY') {
        if (lows[i] <= sl)           { pnl=(sl-entry)/risk; closed=true; }         // SL
        else if (closes[i] < dc.lower) { pnl=(closes[i]-entry)/risk; closed=true; } // contre-cassage
      } else {
        if (highs[i] >= sl)           { pnl=(entry-sl)/risk; closed=true; }
        else if (closes[i] > dc.upper) { pnl=(entry-closes[i])/risk; closed=true; }
      }
      if (!closed && hold >= MAX_HOLD) {
        pnl = type==='BUY'?(closes[i]-entry)/risk:(entry-closes[i])/risk;
        closed=true;
      }
      if (closed) { if (!isNaN(pnl)) pnls.push(pnl-TRADE_COST); inTrade=false; }
      continue;
    }

    const ws  = Math.max(0, i-LOOKBACK+1);
    const ind = calculateIndicators(
      closes.slice(ws,i+1), highs.slice(ws,i+1), lows.slice(ws,i+1),
      opens.slice(ws,i+1),  vols.slice(ws,i+1),  DEFAULT_STRATEGY, symbol
    );
    if (!ind) continue;

    const price = closes[i];
    // Utiliser analyzeMarket pour les filtres d'entrée V15 (ADX, fan, MTF, choppiness)
    const { signal } = analyzeMarket(symbol, price, ind, DEFAULT_STRATEGY);
    if (!signal?.tradeSetup) continue;

    const r = Math.abs(price - signal.tradeSetup.stopLoss);
    if (r <= 0) continue;

    // Entrée Turtle : même signal V15, mais pas de TP fixe
    entry=price; sl=signal.tradeSetup.stopLoss; type=signal.type===SignalType.BUY?'BUY':'SELL';
    risk=r; hold=0; be=false; inTrade=true;
  }
  return pnls;
}

function metrics(pnls: number[]) {
  const n=pnls.length; if (!n) return {n:0,wr:0,e:0,pf:0,dd:0};
  const wins=pnls.filter(p=>p>0).length, wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0),
        lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0)), net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0; for (const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return {n,wr:wins/n,e:net/n,pf:lp>0?wp/lp:wp>0?99:0,dd};
}
function negC(wm: ReturnType<typeof metrics>[]) {
  let m=0,c=0; for(const w of wm){if(w.e<0){c++;m=Math.max(m,c);}else c=0;} return m;
}

// Grid N_EXIT
const EXITS = [
  { label: 'Turtle exit N=10  ', n: 10 },
  { label: 'Turtle exit N=14  ', n: 14 },
  { label: 'Turtle exit N=20  ', n: 20 },
  { label: 'Turtle exit N=30  ', n: 30 },
];

console.log('\n📊 Walk-forward H4 — Turtle (exit Donchian) vs V15 TP-fixe\n');

type Run = { label:string; agg:ReturnType<typeof metrics>; byWin:ReturnType<typeof metrics>[]; negConsec:number };
const runs: Run[] = [];

for (const cfg of EXITS) {
  const allWin: number[][] = winDefs.map(()=>[]);
  for (const ds of datasets)
    for (let w=0; w<WINDOWS_N; w++)
      allWin[w].push(...simulate(ds, winDefs[w].s, winDefs[w].e, cfg.n));
  const byWin = allWin.map(p => metrics(p));
  const agg   = metrics(allWin.flat());
  runs.push({ label: cfg.label, agg, byWin, negConsec: negC(byWin) });
}

const p = (s:string|number, w=8) => String(s).padStart(w);
console.log(`  Config             Trades  WR%    E(R)    PF    MaxDD  OOS5-E  OOS6-E  NegCons  Verdict`);
console.log('  ' + '─'.repeat(96));

for (const r of runs) {
  const oos5=r.byWin[4], oos6=r.byWin[5];
  const v = r.agg.n<CRITERIA.minTrades ? '⚠️  INCONCLUSIVE'
          : r.agg.e<=0||r.negConsec>=CRITERIA.abandonNegConsec ? '❌ ABANDON'
          : r.agg.e>=CRITERIA.minExpectancy&&r.agg.pf>=CRITERIA.minPF&&r.agg.wr>=CRITERIA.minWR ? '✅ EDGE CONFIRMÉ'
          : '⚠️  MARGINAL';
  console.log(`  ${r.label} ${p(r.agg.n,6)}  ${p((r.agg.wr*100).toFixed(0)+'%',4)}  ${p(r.agg.e.toFixed(3),7)}  ${p(r.agg.pf.toFixed(2),5)}  ${p(r.agg.dd.toFixed(1)+'R',6)}  ${p(oos5.e.toFixed(3),7)} ${p(oos6.e.toFixed(3),7)}  ${p(r.negConsec,5)}    ${v}`);
}
console.log(`  ${'V15 TP fixe 2R    '} ${p(138,6)}  ${p('41%',4)}  ${p('+0.045',7)}  ${p('1.08',5)}  ${p('11.9R',6)}  ${p('-0.132',7)} ${p('-0.023',7)}  ${p(2,5)}    ❌ ABANDON`);

const best = runs.filter(r => r.agg.n >= CRITERIA.minTrades).sort((a,b) => b.agg.e - a.agg.e)[0];
console.log(`\n→ Meilleure config Turtle : ${best?.label.trim()} — E=${best?.agg.e.toFixed(3)}R | PF=${best?.agg.pf.toFixed(2)}`);

if (best) {
  console.log(`\n📋 Détail OOS — ${best.label.trim()}\n`);
  console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
  console.log('  ' + '─'.repeat(72));
  for (let w=0; w<WINDOWS_N; w++) {
    const m=best.byWin[w];
    const ic=m.e>=CRITERIA.minExpectancy?'✅':m.e<0?'❌':'⚠️ ';
    console.log(`  ${ic} ${winDefs[w].label.padEnd(10)} ${`${winDefs[w].from} → ${winDefs[w].to}`.padEnd(25)} ${p(m.n,5)}  ${p((m.wr*100).toFixed(0)+'%',4)}  ${p(m.e.toFixed(3),7)}  ${p(m.pf.toFixed(2),5)}  ${p(m.dd.toFixed(1)+'R',5)}`);
  }
}

fs.writeFileSync(path.join(DATA_DIR,'_turtle_h4_results.json'),
  JSON.stringify({generatedAt:Date.now(),runs:runs.map(r=>({label:r.label.trim(),...r.agg,negConsec:r.negConsec,oos5:r.byWin[4],oos6:r.byWin[5],byWin:r.byWin})),best:best?.label.trim()},null,2));
console.log('\n→ Résultats sauvegardés : data/_turtle_h4_results.json\n');
