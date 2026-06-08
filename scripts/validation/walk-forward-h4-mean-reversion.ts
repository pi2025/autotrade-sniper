#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-mean-reversion.ts
 * Étape 1 — Mean Reversion RSI+BB seule, sur données H4 cTrader.
 * Conditions : ADX ≤ 25, Choppiness > 45, RSI < 32 (BUY) / > 68 (SELL),
 *              prix ≤ BB lower + 0.3 ATR (BUY), prix > EMA200.
 * SL = 1.5 ATR | TP = EMA20 à l'entrée | MAX_HOLD = 20 barres H4
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 400;
const MAX_HOLD   = 20;
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;
const SL_MULT    = 1.5;

const ADX_MAX_MR   = 25;
const CHOP_MIN_MR  = 45;
const RSI_BUY      = 32;
const RSI_SELL     = 68;
const BB_TOLERANCE = 0.3;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface Dataset { symbol: string; name: string; bars: Bar[]; }

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4 — lancer fetch-ctrader-h4.ts'); process.exit(1); }

const datasets: Dataset[] = files.map(f => {
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return { symbol: d.symbol, name: d.ctraderName, bars: d.bars };
}).filter(d => d.bars.length >= LOOKBACK + 100);

const ref  = datasets[0].bars;
const bpw  = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const wins = Array.from({ length: WINDOWS_N }, (_, w) => ({
  label: `OOS-${w+1}`,
  from: new Date(ref[LOOKBACK + w*bpw]?.ts ?? 0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK + (w+1)*bpw-1]?.ts ?? 0).toISOString().slice(0,10),
  s: LOOKBACK + w*bpw,
  e: LOOKBACK + (w+1)*bpw,
}));

function simulate(ds: Dataset, start: number, end: number): number[] {
  const { symbol, bars } = ds;
  const closes = bars.map(b=>b.close), highs = bars.map(b=>b.high),
        lows   = bars.map(b=>b.low),   opens = bars.map(b=>b.open),
        vols   = bars.map(b=>b.volume);
  const pnls: number[] = [];
  let inTrade=false, entry=0, sl=0, tp=0, type='', hold=0, risk=0;

  for (let i=start; i<end; i++) {
    if (inTrade) {
      hold++;
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

    const price = closes[i];
    const bb    = ind.bollingerBands;

    if (ind.adx > ADX_MAX_MR)          continue;
    if (ind.choppiness <= CHOP_MIN_MR)  continue;

    const buySignal  = ind.rsi < RSI_BUY
                    && price <= bb.lower + ind.atr * BB_TOLERANCE
                    && price > ind.ema200;

    const sellSignal = ind.rsi > RSI_SELL
                    && price >= bb.upper - ind.atr * BB_TOLERANCE
                    && price < ind.ema200;

    if (!buySignal && !sellSignal) continue;

    const r = ind.atr * SL_MULT;
    if (r <= 0) continue;

    if (buySignal) {
      entry=price; sl=price-r; tp=bb.middle;
      type='BUY'; risk=r; hold=0; inTrade=true;
    } else {
      entry=price; sl=price+r; tp=bb.middle;
      type='SELL'; risk=r; hold=0; inTrade=true;
    }
  }
  return pnls;
}

function metrics(pnls: number[]) {
  const n = pnls.length;
  if (!n) return { n:0, wr:0, e:0, pf:0, dd:0, net:0 };
  const wins  = pnls.filter(p=>p>0).length;
  const wp    = pnls.filter(p=>p>0).reduce((s,p)=>s+p, 0);
  const lp    = Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p, 0));
  const net   = pnls.reduce((s,p)=>s+p, 0);
  let pk=0, eq=0, dd=0;
  for (const p of pnls) { eq+=p; if(eq>pk)pk=eq; dd=Math.max(dd, pk-eq); }
  return { n, wr:wins/n, e:net/n, pf:lp>0?wp/lp:wp>0?99:0, dd, net };
}

const allWinPnls: number[][] = wins.map(()=>[]);
for (const ds of datasets)
  for (let w=0; w<WINDOWS_N; w++)
    allWinPnls[w].push(...simulate(ds, wins[w].s, wins[w].e));

const results = wins.map((w,i) => ({ ...metrics(allWinPnls[i]), label:w.label, from:w.from, to:w.to }));
const agg     = { ...metrics(allWinPnls.flat()), label:'AGRÉGÉ', from:wins[0].from, to:wins[WINDOWS_N-1].to };

const CRITERIA = { minExpectancy:0.05, minPF:1.10, minTrades:20 };
const negC = (() => { let m=0,c=0; for(const r of results){ if(r.e<0){c++;m=Math.max(m,c);}else c=0; } return m; })();

console.log('\n📊 Walk-forward H4 — Mean Reversion RSI+BB\n');
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
console.log('  ' + '─'.repeat(72));
for (const r of results) {
  const ic = r.e>=CRITERIA.minExpectancy?'✅':r.e<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${r.label.padEnd(10)} ${`${r.from} → ${r.to}`.padEnd(25)} ${String(r.n).padStart(5)}  ${((r.wr*100).toFixed(0)+'%').padStart(4)}  ${r.e.toFixed(3).padStart(7)}  ${r.pf.toFixed(2).padStart(5)}  ${r.dd.toFixed(1).padStart(5)}R`);
}
console.log('  ' + '─'.repeat(72));
console.log(`  ⭐ ${agg.label.padEnd(10)} ${`${agg.from} → ${agg.to}`.padEnd(25)} ${String(agg.n).padStart(5)}  ${((agg.wr*100).toFixed(0)+'%').padStart(4)}  ${agg.e.toFixed(3).padStart(7)}  ${agg.pf.toFixed(2).padStart(5)}  ${agg.dd.toFixed(1).padStart(5)}R`);

const hasEdge = agg.n >= CRITERIA.minTrades && agg.e >= CRITERIA.minExpectancy && agg.pf >= CRITERIA.minPF;
const verdict = agg.n < CRITERIA.minTrades ? `⚠️  INCONCLUSIVE — ${agg.n} trades` : hasEdge ? `✅ EDGE MR CONFIRMÉ — E=${agg.e.toFixed(3)}R | PF=${agg.pf.toFixed(2)}` : `❌ PAS D'EDGE MR — E=${agg.e.toFixed(3)}R | NegConsec=${negC}`;
console.log(`\n  Verdict MR seule : ${verdict}\n`);

fs.writeFileSync(path.join(DATA_DIR,'_h4_mr_results.json'), JSON.stringify({ generatedAt:Date.now(), results, aggregate:agg, verdict, negConsec:negC }, null, 2));
