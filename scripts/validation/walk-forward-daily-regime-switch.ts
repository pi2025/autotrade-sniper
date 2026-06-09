#!/usr/bin/env npx tsx
/**
 * walk-forward-daily-regime-switch.ts
 * Étape 3b — Market Regime Switching sur Daily cTrader.
 * ADX > 25  → TREND : V15 Sniper (Donchian breakout)
 * ADX ≤ 25  → RANGE : Mean Reversion RSI+BB
 * Paramètres adaptés au D1 : LOOKBACK=200, MAX_HOLD_TREND=20j, MAX_HOLD_MR=10j
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 300; // calculateIndicators requiert len >= 250 — 300 pour EMA200 fiable sur Daily
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;

const MAX_HOLD_TREND = 20;
const MAX_HOLD_MR    = 10;
const SL_MULT_MR     = 1.5;
const ADX_MAX_MR     = 25;
const CHOP_MIN_MR    = 45;
const RSI_BUY        = 32;
const RSI_SELL       = 68;
const BB_TOLERANCE   = 0.3;

const CRITERIA = { minExpectancy:0.10, minWindows:3, minPF:1.30, minWR:0.38, minTrades:50, abandonNegConsec:2 };

interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number; }
interface Dataset { symbol:string; name:string; bars:Bar[]; }

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_d1_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers Daily — lancer fetch-ctrader-daily.ts'); process.exit(1); }

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

function simulate(ds: Dataset, start: number, end: number): { pnls:number[]; trendN:number; mrN:number } {
  const { symbol, bars } = ds;
  const closes=bars.map(b=>b.close), highs=bars.map(b=>b.high), lows=bars.map(b=>b.low),
        opens=bars.map(b=>b.open),   vols=bars.map(b=>b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, tp=0, type='', hold=0, risk=0, be=false, maxHold=0;
  let trendN=0, mrN=0;

  for (let i=start; i<end; i++) {
    if (inTrade) {
      hold++;
      if (!be && maxHold===MAX_HOLD_TREND &&
          (type==='BUY'?closes[i]-entry:entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }
      let closed=false, pnl=0;
      if (type==='BUY') {
        if (lows[i]<=sl)       { pnl=(sl-entry)/risk; closed=true; }
        else if (highs[i]>=tp) { pnl=(tp-entry)/risk; closed=true; }
      } else {
        if (highs[i]>=sl)      { pnl=(entry-sl)/risk; closed=true; }
        else if (lows[i]<=tp)  { pnl=(entry-tp)/risk; closed=true; }
      }
      if (!closed && hold >= maxHold) {
        pnl = type==='BUY' ? (closes[i]-entry)/risk : (entry-closes[i])/risk;
        closed = true;
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

    const price   = closes[i];
    const isTrend = ind.adx > ADX_MAX_MR;

    if (isTrend) {
      const { signal } = analyzeMarket(symbol, price, ind, DEFAULT_STRATEGY);
      if (!signal?.tradeSetup) continue;
      const r = Math.abs(price - signal.tradeSetup.stopLoss);
      if (r <= 0) continue;
      entry=price; sl=signal.tradeSetup.stopLoss; tp=signal.tradeSetup.takeProfit;
      type=signal.type===SignalType.BUY?'BUY':'SELL'; risk=r; hold=0; be=false;
      maxHold=MAX_HOLD_TREND; inTrade=true; trendN++;
    } else {
      if (ind.choppiness <= CHOP_MIN_MR) continue;
      const bb = ind.bollingerBands;
      const buyOk  = ind.rsi < RSI_BUY
                  && price <= bb.lower + ind.atr * BB_TOLERANCE
                  && price > ind.ema200;
      const sellOk = ind.rsi > RSI_SELL
                  && price >= bb.upper - ind.atr * BB_TOLERANCE
                  && price < ind.ema200;
      if (!buyOk && !sellOk) continue;
      const r = ind.atr * SL_MULT_MR;
      if (r <= 0) continue;
      if (buyOk)  { entry=price; sl=price-r; tp=bb.middle; type='BUY';  }
      else        { entry=price; sl=price+r; tp=bb.middle; type='SELL'; }
      risk=r; hold=0; be=false; maxHold=MAX_HOLD_MR; inTrade=true; mrN++;
    }
  }
  return { pnls, trendN, mrN };
}

function metrics(pnls: number[]) {
  const n=pnls.length; if (!n) return {n:0,wr:0,e:0,pf:0,dd:0};
  const wins=pnls.filter(p=>p>0).length, wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0),
        lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0)), net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0; for (const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return {n,wr:wins/n,e:net/n,pf:lp>0?wp/lp:wp>0?99:0,dd};
}

const allWinPnls: number[][] = winDefs.map(()=>[]);
let totalTrend=0, totalMR=0;
for (const ds of datasets) {
  process.stdout.write(`  ▶ ${ds.name.padEnd(8)} `);
  for (let w=0; w<WINDOWS_N; w++) {
    const { pnls, trendN, mrN } = simulate(ds, winDefs[w].s, winDefs[w].e);
    allWinPnls[w].push(...pnls);
    totalTrend+=trendN; totalMR+=mrN;
    process.stdout.write(`W${w+1}:${pnls.length} `);
  }
  console.log();
}

const results = winDefs.map((w,i) => ({...metrics(allWinPnls[i]), label:w.label, from:w.from, to:w.to}));
const agg = {...metrics(allWinPnls.flat()), label:'AGRÉGÉ', from:winDefs[0].from, to:winDefs[WINDOWS_N-1].to};
const negC = (()=>{let m=0,c=0;for(const r of results){if(r.e<0){c++;m=Math.max(m,c);}else c=0;}return m;})();
const passing = results.filter(r => r.e >= CRITERIA.minExpectancy).length;

console.log('\n══════════════════════════════ Walk-forward Daily — Regime Switching ══');
console.log(`  Mix trades → Trend: ${totalTrend} | MR: ${totalMR}`);
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
console.log('  ' + '─'.repeat(72));
for (const r of results) {
  const ic=r.e>=CRITERIA.minExpectancy?'✅':r.e<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${r.label.padEnd(10)} ${`${r.from} → ${r.to}`.padEnd(25)} ${String(r.n).padStart(5)}  ${((r.wr*100).toFixed(0)+'%').padStart(4)}  ${r.e.toFixed(3).padStart(7)}  ${r.pf.toFixed(2).padStart(5)}  ${r.dd.toFixed(1).padStart(5)}R`);
}
console.log('  ' + '─'.repeat(72));
console.log(`  ⭐ ${agg.label.padEnd(10)} ${`${agg.from} → ${agg.to}`.padEnd(25)} ${String(agg.n).padStart(5)}  ${((agg.wr*100).toFixed(0)+'%').padStart(4)}  ${agg.e.toFixed(3).padStart(7)}  ${agg.pf.toFixed(2).padStart(5)}  ${agg.dd.toFixed(1).padStart(5)}R`);

let verdict='';
if (agg.n < CRITERIA.minTrades)                                       verdict=`⚠️  INCONCLUSIVE — ${agg.n} trades`;
else if (agg.e<=0 || negC>=CRITERIA.abandonNegConsec)                 verdict=`❌ ABANDON — E=${agg.e.toFixed(3)}R, ${negC} fenêtres négatives consécutives`;
else if (passing>=CRITERIA.minWindows && agg.pf>=CRITERIA.minPF
         && agg.wr>=CRITERIA.minWR)                                   verdict=`✅ EDGE CONFIRMÉ — E=${agg.e.toFixed(3)}R | PF=${agg.pf.toFixed(2)} | WR=${(agg.wr*100).toFixed(0)}%`;
else                                                                  verdict=`⚠️  EDGE MARGINAL — E=${agg.e.toFixed(3)}R | ${passing}/${WINDOWS_N} fenêtres OK`;

console.log(`\n  Verdict Regime Switch Daily : ${verdict}\n`);
fs.writeFileSync(path.join(DATA_DIR,'_daily_regime_switch_results.json'),
  JSON.stringify({generatedAt:Date.now(),source:'ctrader_d1',strategy:'regime_switch',criteria:CRITERIA,results,aggregate:agg,verdict,tradesMix:{trend:totalTrend,mr:totalMR},negConsec:negC},null,2));
