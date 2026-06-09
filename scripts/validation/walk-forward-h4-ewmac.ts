#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-ewmac.ts
 *
 * Test EWMAC (Exponentially Weighted Moving Average Crossover) sur H4 cTrader.
 * Méthode Man AHL / Rob Carver "Systematic Trading" — Sharpe 0.7-1.0 documenté Forex.
 *
 * Différence vs V15 Donchian :
 *   - Signal = croisement EMA fast/slow (trend change) vs cassage de canal (prix level)
 *   - Plus de signaux, diversification temporelle via 3 vitesses
 *   - Pas de Donchian, ADX seuil abaissé à 15 (confirme juste qu'une tendance existe)
 *
 * Grid : 3 vitesses EWMAC8/32 | EWMAC16/64 | EWMAC32/128 + combiné 2/3
 * Comparaison directe vs V15 baseline.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 400;
const MAX_HOLD   = 40;   // EWMAC tient les trades plus longtemps
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;
const SL_MULT    = 2.0;
const RR         = 2.0;
const ADX_MIN    = 15;   // Seuil bas — juste confirmer qu'une tendance existe

interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number; }
interface Dataset { symbol:string; name:string; bars:Bar[]; }

// EMA calculée sur un tableau se terminant à l'index idx
function ema(data: number[], period: number, endIdx: number): number {
  const start = Math.max(0, endIdx - LOOKBACK + 1);
  const slice = data.slice(start, endIdx + 1);
  if (slice.length < period) return slice[slice.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let val = slice.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < slice.length; i++) val = (slice[i] - val) * k + val;
  return val;
}

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

type Speed = { fast: number; slow: number };
const SPEEDS: Speed[] = [
  { fast: 8,  slow: 32  },
  { fast: 16, slow: 64  },
  { fast: 32, slow: 128 },
];

function simulate(ds: Dataset, start: number, end: number, speeds: Speed[]): number[] {
  const { symbol, bars } = ds;
  const closes = bars.map(b => b.close), highs = bars.map(b => b.high),
        lows   = bars.map(b => b.low),   opens  = bars.map(b => b.open),
        vols   = bars.map(b => b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, tp=0, type='', hold=0, risk=0, be=false;

  for (let i = start; i < end; i++) {
    if (inTrade) {
      hold++;
      if (!be && (type==='BUY' ? closes[i]-entry : entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }
      let closed=false, pnl=0;
      if (type==='BUY') {
        if (lows[i]<=sl)        { pnl=(sl-entry)/risk; closed=true; }
        else if (highs[i]>=tp)  { pnl=(tp-entry)/risk; closed=true; }
      } else {
        if (highs[i]>=sl)       { pnl=(entry-sl)/risk; closed=true; }
        else if (lows[i]<=tp)   { pnl=(entry-tp)/risk; closed=true; }
      }
      if (!closed && hold >= MAX_HOLD) {
        pnl = type==='BUY' ? (closes[i]-entry)/risk : (entry-closes[i])/risk;
        closed = true;
      }
      if (closed) { if (!isNaN(pnl)) pnls.push(pnl - TRADE_COST); inTrade=false; }
      continue;
    }

    const ws  = Math.max(0, i - LOOKBACK + 1);
    const ind = calculateIndicators(
      closes.slice(ws,i+1), highs.slice(ws,i+1), lows.slice(ws,i+1),
      opens.slice(ws,i+1),  vols.slice(ws,i+1),  DEFAULT_STRATEGY, symbol
    );
    if (!ind) continue;
    if (ind.adx < ADX_MIN) continue;
    if (!ind.atr || ind.atr <= 0) continue;

    const price = closes[i];

    // Signal EWMAC : compter combien de vitesses pointent BUY vs SELL
    let bullVotes = 0, bearVotes = 0;
    for (const spd of speeds) {
      const fastVal = ema(closes, spd.fast, i);
      const slowVal = ema(closes, spd.slow, i);
      if (fastVal > slowVal) bullVotes++;
      else if (fastVal < slowVal) bearVotes++;
    }

    // Filtre direction : EMA200 confirme la tendance de fond
    const bullFund = price > ind.ema200;
    const bearFund = price < ind.ema200;

    // Filtre choppiness : éviter les marchés trop hachés
    if (ind.choppiness > 61.8) continue;

    const isBuy  = bullVotes > bearVotes && bullFund;
    const isSell = bearVotes > bullVotes && bearFund;
    if (!isBuy && !isSell) continue;

    // Vérifier un croisement récent (dans les 3 dernières barres)
    // pour éviter d'entrer au milieu d'une tendance déjà établie
    let recentCross = false;
    for (const spd of speeds) {
      if (i < 1) continue;
      const fastNow  = ema(closes, spd.fast, i);
      const slowNow  = ema(closes, spd.slow, i);
      const fastPrev = ema(closes, spd.fast, i-1);
      const slowPrev = ema(closes, spd.slow, i-1);
      if (isBuy  && fastNow > slowNow && fastPrev <= slowPrev) recentCross = true;
      if (isSell && fastNow < slowNow && fastPrev >= slowPrev) recentCross = true;
    }
    // Sans croisement récent, n'entrer que si toutes les vitesses convergent (signal fort)
    if (!recentCross && Math.abs(bullVotes - bearVotes) < speeds.length) continue;

    const r = ind.atr * SL_MULT;
    if (r <= 0) continue;

    if (isBuy)  { entry=price; sl=price-r; tp=price+r*RR; type='BUY';  }
    else        { entry=price; sl=price+r; tp=price-r*RR; type='SELL'; }
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
function negConsec(wm: ReturnType<typeof metrics>[]) {
  let m=0,c=0; for (const w of wm){if(w.e<0){c++;m=Math.max(m,c);}else c=0;} return m;
}

// Configs à tester
const CONFIGS = [
  { label: 'EWMAC 8/32          ', speeds: [SPEEDS[0]] },
  { label: 'EWMAC 16/64         ', speeds: [SPEEDS[1]] },
  { label: 'EWMAC 32/128        ', speeds: [SPEEDS[2]] },
  { label: 'EWMAC multi 2/3     ', speeds: SPEEDS },
];

const CRITERIA = { minExpectancy:0.10, minWindows:3, minPF:1.30, minWR:0.38, minTrades:30, abandonNegConsec:2 };

console.log('\n📊 Walk-forward H4 — EWMAC vs V15 Baseline\n');

type RunResult = { label:string; agg:ReturnType<typeof metrics>; byWin:ReturnType<typeof metrics>[]; negC:number };
const allRuns: RunResult[] = [];

for (const cfg of CONFIGS) {
  const allWin: number[][] = winDefs.map(()=>[]);
  for (const ds of datasets)
    for (let w=0; w<WINDOWS_N; w++)
      allWin[w].push(...simulate(ds, winDefs[w].s, winDefs[w].e, cfg.speeds));
  const byWin = allWin.map(p => metrics(p));
  const agg   = metrics(allWin.flat());
  allRuns.push({ label: cfg.label, agg, byWin, negC: negConsec(byWin) });
}

// Affichage tableau récap
const p = (s:string|number, w=8) => String(s).padStart(w);
console.log(`  Config                  Trades  WR%    E(R)    PF    MaxDD  OOS5-E  OOS6-E  NegCons  Verdict`);
console.log('  ' + '─'.repeat(100));

for (const r of allRuns) {
  const oos5=r.byWin[4], oos6=r.byWin[5];
  const v = r.agg.n < CRITERIA.minTrades ? '⚠️  INCONCLUSIVE'
          : r.agg.e<=0 || r.negC>=CRITERIA.abandonNegConsec ? '❌ ABANDON'
          : r.agg.e>=CRITERIA.minExpectancy && r.agg.pf>=CRITERIA.minPF && r.agg.wr>=CRITERIA.minWR ? '✅ EDGE CONFIRMÉ'
          : '⚠️  MARGINAL';
  console.log(`  ${r.label} ${p(r.agg.n,6)}  ${p((r.agg.wr*100).toFixed(0)+'%',4)}  ${p(r.agg.e.toFixed(3),7)}  ${p(r.agg.pf.toFixed(2),5)}  ${p(r.agg.dd.toFixed(1)+'R',6)}  ${p(oos5.e.toFixed(3),7)} ${p(oos6.e.toFixed(3),7)}  ${p(r.negC,5)}    ${v}`);
}

// Baseline V15 pour référence
console.log(`  ${'V15 Baseline (ref)   '} ${'138'.padStart(6)}  ${'41%'.padStart(4)}  ${'+0.045'.padStart(7)}  ${'1.08'.padStart(5)}  ${'11.9R'.padStart(6)}  ${'-0.132'.padStart(7)} ${'-0.023'.padStart(7)}  ${'2'.padStart(5)}    ❌ ABANDON`);

// Meilleure config
const best = allRuns.filter(r => r.agg.n >= CRITERIA.minTrades).sort((a,b) => b.agg.e - a.agg.e)[0];
console.log(`\n→ Meilleure EWMAC : ${best?.label.trim()} — E=${best?.agg.e.toFixed(3)}R | PF=${best?.agg.pf.toFixed(2)} | WR=${((best?.agg.wr??0)*100).toFixed(0)}%`);

// Détail OOS de la meilleure
if (best) {
  console.log(`\n📋 Détail OOS — ${best.label.trim()}\n`);
  console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF');
  console.log('  ' + '─'.repeat(68));
  for (let w=0; w<WINDOWS_N; w++) {
    const m = best.byWin[w];
    const ic = m.e>=CRITERIA.minExpectancy?'✅':m.e<0?'❌':'⚠️ ';
    console.log(`  ${ic} ${winDefs[w].label.padEnd(10)} ${`${winDefs[w].from} → ${winDefs[w].to}`.padEnd(25)} ${p(m.n,5)}  ${p((m.wr*100).toFixed(0)+'%',4)}  ${p(m.e.toFixed(3),7)}  ${p(m.pf.toFixed(2),5)}`);
  }
}

fs.writeFileSync(path.join(DATA_DIR,'_ewmac_h4_results.json'),
  JSON.stringify({ generatedAt:Date.now(), configs:allRuns.map(r=>({label:r.label.trim(),...r.agg,negConsec:r.negC,oos5:r.byWin[4],oos6:r.byWin[5]})), best:best?.label.trim() }, null, 2));
console.log('\n→ Résultats sauvegardés : data/_ewmac_h4_results.json\n');
