#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-pullback.ts
 *
 * Test Option B : entrée sur pullback EMA20.
 *
 * Logique :
 *   1. Tous les filtres existants passent (ADX, Choppiness, MTF, Fan)
 *   2. Un breakout Donchian a été confirmé dans les BREAKOUT_LOOKBACK dernières barres
 *   3. Le prix est revenu en zone EMA20 (price <= ema20 + atr * tolerance pour bull)
 *   4. Entrée à la clôture de la barre de pullback
 *
 * SL = 1.5 ATR sous l'entrée (tighter — on entre à meilleur prix)
 * TP = 2R (= 3.0 ATR)
 *
 * Grid sur tolerance : 0.2 / 0.5 / 1.0 ATR
 * Comparaison vs baseline (breakout entry).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK          = 400;
const MAX_HOLD          = 30;
const TRADE_COST        = 0.05;
const WINDOWS_N         = 6;
const BREAKOUT_LOOKBACK = 10;   // barres H4 max après le breakout pour chercher le repli
const SL_MULT_PULLBACK  = 1.5;  // SL plus serré car entrée à meilleur prix
const RR                = 2.0;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; bars: Bar[]; }

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
  from: new Date(ref[LOOKBACK + w * bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK + (w+1)*bpw - 1]?.ts ?? 0).toISOString().slice(0,10),
  s: LOOKBACK + w * bpw,
  e: LOOKBACK + (w+1) * bpw,
}));

// ── Baseline : entrée breakout Donchian (logique originale) ──────────────────
function simulateBaseline(symbol: string, bars: Bar[], start: number, end: number): number[] {
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
      const ws=Math.max(0,i-LOOKBACK+1);
      const ind=calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),DEFAULT_STRATEGY,symbol);
      if (!ind) continue;
      const indA = ind as any;
      const price = closes[i];
      const mtfOk = ind.mtfAlignment?.isAligned;
      const isNotChoppy = ind.choppiness < 55;
      const isAdxStrong = ind.adx >= DEFAULT_STRATEGY.adxThreshold;
      const isAdxRising = ind.adxSlope === 'RISING';
      const isWidening = indA.isWidening;
      const rsiOk = !(ind.rsi > 72 || ind.rsi < 28);
      if (!mtfOk||!isNotChoppy||!isAdxStrong||!isAdxRising||!isWidening||!rsiOk) continue;
      const isBullFan = price>ind.ema20&&ind.ema20>ind.ema50&&ind.ema50>ind.ema200;
      const isBearFan = price<ind.ema20&&ind.ema20<ind.ema50&&ind.ema50<ind.ema200;
      const buf = ind.atr*0.15;
      const isBullBreak = price>(ind.donchian.upper+buf)&&isBullFan;
      const isBearBreak = price<(ind.donchian.lower-buf)&&isBearFan;
      if (!isBullBreak&&!isBearBreak) continue;
      const t = isBullBreak ? SignalType.BUY : SignalType.SELL;
      const r = ind.atr * DEFAULT_STRATEGY.stopLossAtrMultiplier;
      const slPrice = t===SignalType.BUY?price-r:price+r;
      const tpPrice = t===SignalType.BUY?price+r*2:price-r*2;
      inTrade=true; entry=price; sl=slPrice; tp=tpPrice; type=t===SignalType.BUY?'BUY':'SELL'; risk=r; hold=0; be=false;
    }
  }
  return pnls;
}

// ── Pullback entry ───────────────────────────────────────────────────────────
function simulatePullback(symbol: string, bars: Bar[], start: number, end: number, tolerance: number): number[] {
  const closes = bars.map(b=>b.close), highs = bars.map(b=>b.high), lows = bars.map(b=>b.low), opens = bars.map(b=>b.open), vols = bars.map(b=>b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, tp=0, type='', hold=0, risk=0, be=false;

  // État du breakout en attente de repli
  let pendingDir: 'BUY'|'SELL'|null = null;
  let breakoutBar = -BREAKOUT_LOOKBACK - 1;

  for (let i=start; i<end; i++) {
    if (inTrade) {
      hold++;
      if (!be && (type==='BUY'?closes[i]-entry:entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }
      let closed=false, pnl=0;
      if (type==='BUY') { if(lows[i]<=sl){pnl=(sl-entry)/risk;closed=true;} else if(highs[i]>=tp){pnl=(tp-entry)/risk;closed=true;} }
      else              { if(highs[i]>=sl){pnl=(entry-sl)/risk;closed=true;} else if(lows[i]<=tp){pnl=(entry-tp)/risk;closed=true;} }
      if (!closed && hold>=MAX_HOLD) { pnl=type==='BUY'?(closes[i]-entry)/risk:(entry-closes[i])/risk; closed=true; }
      if (closed) { if (!isNaN(pnl)) pnls.push(pnl-TRADE_COST); inTrade=false; pendingDir=null; }
      continue;
    }

    const ws=Math.max(0,i-LOOKBACK+1);
    const ind=calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),DEFAULT_STRATEGY,symbol);
    if (!ind) { pendingDir=null; continue; }

    const indA = ind as any;
    const price = closes[i];
    const mtfOk = ind.mtfAlignment?.isAligned;
    const isNotChoppy = ind.choppiness < 55;
    const isAdxStrong = ind.adx >= DEFAULT_STRATEGY.adxThreshold;
    const isAdxRising = ind.adxSlope === 'RISING';
    const isWidening = indA.isWidening;
    const rsiOk = !(ind.rsi > 72 || ind.rsi < 28);

    // Filtres de base toujours requis (sauf rsiOk — assoupli sur le repli)
    if (!mtfOk||!isNotChoppy||!isAdxStrong||!isWidening) { pendingDir=null; continue; }

    const isBullFan = ind.ema20>ind.ema50&&ind.ema50>ind.ema200;
    const isBearFan = ind.ema20<ind.ema50&&ind.ema50<ind.ema200;
    const buf = ind.atr * 0.15;

    // Expiration du breakout en attente
    if (pendingDir && (i - breakoutBar) > BREAKOUT_LOOKBACK) { pendingDir = null; }

    // Détection d'un nouveau breakout → arme le pendingDir
    if (!pendingDir) {
      if (!isAdxRising) continue; // ADX rising requis pour armer le breakout
      const breakoutBull = price>(ind.donchian.upper+buf) && isBullFan && price>ind.ema20;
      const breakoutBear = price<(ind.donchian.lower-buf) && isBearFan && price<ind.ema20;
      if (breakoutBull) { pendingDir='BUY'; breakoutBar=i; }
      else if (breakoutBear) { pendingDir='SELL'; breakoutBar=i; }
      continue; // ne pas entrer le jour du breakout — attendre le repli
    }

    // Vérification du repli vers EMA20
    if (pendingDir === 'BUY') {
      if (!isBullFan) { pendingDir=null; continue; } // fan cassé → invalide
      const pullbackZone = price <= ind.ema20 + ind.atr * tolerance && price >= ind.ema50;
      if (!pullbackZone) continue;
      // Entrée sur repli Bull
      const r = ind.atr * SL_MULT_PULLBACK;
      const slPrice = price - r;
      const tpPrice = price + r * RR;
      if (r <= 0) continue;
      inTrade=true; entry=price; sl=slPrice; tp=tpPrice; type='BUY'; risk=r; hold=0; be=false; pendingDir=null;
    } else {
      if (!isBearFan) { pendingDir=null; continue; }
      const pullbackZone = price >= ind.ema20 - ind.atr * tolerance && price <= ind.ema50;
      if (!pullbackZone) continue;
      const r = ind.atr * SL_MULT_PULLBACK;
      const slPrice = price + r;
      const tpPrice = price - r * RR;
      if (r <= 0) continue;
      inTrade=true; entry=price; sl=slPrice; tp=tpPrice; type='SELL'; risk=r; hold=0; be=false; pendingDir=null;
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
function negConsec(wm: ReturnType<typeof metrics>[]) {
  let m=0,c=0; for(const w of wm){if(w.e<0){c++;m=Math.max(m,c);}else c=0;} return m;
}

const TOLERANCES = [0.2, 0.5, 1.0];

// ── Calcul baseline ──────────────────────────────────────────────────────────
const baseWinPnls: number[][] = winDefs.map(()=>[]);
for (const ds of datasets) for (let w=0;w<WINDOWS_N;w++) baseWinPnls[w].push(...simulateBaseline(ds.symbol,ds.bars,winDefs[w].s,winDefs[w].e));
const baseByWin = baseWinPnls.map(p=>metrics(p));
const baseAgg = metrics(baseWinPnls.flat());

// ── Calcul pullback grid ─────────────────────────────────────────────────────
type Run = { label: string; agg: ReturnType<typeof metrics>; byWin: ReturnType<typeof metrics>[]; negC: number };
const runs: Run[] = [{ label: 'BASELINE (breakout entry)', agg: baseAgg, byWin: baseByWin, negC: negConsec(baseByWin) }];

for (const tol of TOLERANCES) {
  const allWin: number[][] = winDefs.map(()=>[]);
  for (const ds of datasets) for (let w=0;w<WINDOWS_N;w++) allWin[w].push(...simulatePullback(ds.symbol,ds.bars,winDefs[w].s,winDefs[w].e,tol));
  const byWin = allWin.map(p=>metrics(p));
  const agg = metrics(allWin.flat());
  runs.push({ label: `Pullback EMA20 ±${tol.toFixed(1)}ATR`, agg, byWin, negC: negConsec(byWin) });
}

// ── Affichage ────────────────────────────────────────────────────────────────
console.log('\n📊 Walk-forward H4 — Test Option B : Pullback Entry vs Breakout Entry\n');
const p = (s: string|number, w=8) => String(s).padStart(w);
console.log(`  Config                       Trades  WR%    E(R)    PF    MaxDD  OOS5-E  OOS6-E  NegCons  Verdict`);
console.log('  ' + '─'.repeat(104));

for (const r of runs) {
  const oos5=r.byWin[4], oos6=r.byWin[5];
  const v = r.agg.n < 20 ? '⚠️  INSUFFISANT' : r.agg.e <= 0 || r.negC >= 2 ? '❌ ABANDON' : r.agg.e >= 0.10 && r.agg.pf >= 1.30 && r.agg.wr >= 0.38 ? '✅ EDGE CONFIRMÉ' : '⚠️  MARGINAL';
  const tag = r.label.includes('BASELINE') ? ' ←' : '  ';
  console.log(`  ${r.label.padEnd(28)}${tag} ${p(r.agg.n,6)}  ${p((r.agg.wr*100).toFixed(0)+'%',4)}  ${p(r.agg.e.toFixed(3),7)}  ${p(r.agg.pf.toFixed(2),5)}  ${p(r.agg.dd.toFixed(1)+'R',6)}  ${p(oos5.e.toFixed(3),7)} ${p(oos6.e.toFixed(3),7)}  ${p(r.negC,5)}    ${v}`);
}

// Meilleure config
const best = runs.filter(r=>r.agg.n>=20).sort((a,b)=>b.agg.e-a.agg.e)[0];
console.log(`\n→ Meilleure config : ${best.label.trim()}`);
console.log(`  E(R):  ${baseAgg.e.toFixed(3)} → ${best.agg.e.toFixed(3)}  (${best.agg.e>=baseAgg.e?'+':''}${(best.agg.e-baseAgg.e).toFixed(3)}R/trade)`);

// Détail fenêtre par fenêtre de la meilleure config
const bestRun = best;
console.log(`\n📋 Détail OOS — ${bestRun.label.trim()}\n`);
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF');
console.log('  ' + '─'.repeat(70));
for (let w=0;w<WINDOWS_N;w++) {
  const m=bestRun.byWin[w];
  const ic=m.e>=0.10?'✅':m.e<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${winDefs[w].label.padEnd(10)} ${`${winDefs[w].from} → ${winDefs[w].to}`.padEnd(25)} ${p(m.n,5)}  ${p((m.wr*100).toFixed(0)+'%',4)}  ${p(m.e.toFixed(3),7)}  ${p(m.pf.toFixed(2),5)}`);
}

fs.writeFileSync(path.join(DATA_DIR,'_pullback_h4.json'), JSON.stringify({generatedAt:Date.now(),runs:runs.map(r=>({label:r.label,...r.agg,oos5:r.byWin[4],oos6:r.byWin[5],negConsec:r.negC,byWin:r.byWin}))},null,2));
console.log('\n→ Résultats sauvegardés : data/_pullback_h4.json\n');
