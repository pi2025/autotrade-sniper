#!/usr/bin/env npx tsx
// Walk-forward sur données H4 cTrader — même logique que walk-forward-ctrader.ts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const LOOKBACK   = 400;  // >> EMA200 sur H4
const MAX_HOLD   = 30;   // 30 barres H4 = 5 jours max
const TRADE_COST = 0.05;
const WINDOWS_N  = 6;
const CRITERIA   = { minExpectancy: 0.10, minWindows: 3, minPF: 1.30, minWR: 0.38, minTrades: 30, abandonNegConsec: 2 };

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; ctraderName: string; bars: Bar[]; }

function simulateWindow(symbol: string, bars: Bar[], start: number, end: number): number[] {
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
      const {signal}=analyzeMarket(symbol,closes[i],ind,DEFAULT_STRATEGY);
      if (signal?.tradeSetup) {
        const r = Math.abs(closes[i] - signal.tradeSetup.stopLoss);
        if (r <= 0) continue; // garde anti-NaN : ignore les trades avec SL = entry
        inTrade=true; entry=closes[i]; sl=signal.tradeSetup.stopLoss; tp=signal.tradeSetup.takeProfit; type=signal.type===SignalType.BUY?'BUY':'SELL'; risk=r; hold=0; be=false;
      }
    }
  }
  return pnls;
}

function metrics(pnls: number[], label: string, from: string, to: string) {
  const n=pnls.length; if(!n) return {label,from,to,trades:0,winRate:0,expectancy:0,profitFactor:0,maxDD:0,netPnL:0};
  const wins=pnls.filter(p=>p>0).length, wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0), lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0)), net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0; for(const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return {label,from,to,trades:n,winRate:wins/n,expectancy:net/n,profitFactor:lp>0?wp/lp:wp>0?99:0,maxDD:dd,netPnL:net};
}

const files = fs.readdirSync(DATA_DIR).filter(f=>f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Aucun fichier H4 — lancer fetch-ctrader-h4.ts d\'abord.'); process.exit(1); }

const datasets = files.map(f=>{const d:HistoricalData=JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'));return{symbol:d.symbol,name:d.ctraderName,bars:d.bars};}).filter(d=>d.bars.length>=LOOKBACK+100);
const ref=datasets[0].bars, bpw=Math.floor((ref.length-LOOKBACK)/WINDOWS_N);
const wins=Array.from({length:WINDOWS_N},(_,w)=>({label:`OOS-${w+1}`,s:LOOKBACK+w*bpw,e:LOOKBACK+(w+1)*bpw}));

console.log(`\n📊 Walk-forward H4 cTrader — 7 filtres | ${datasets.length} actifs | ${WINDOWS_N} fenêtres (~${bpw} barres)\n`);

const allPnls:number[][]=wins.map(()=>[]);
for (const ds of datasets) {
  process.stdout.write(`  ▶ ${ds.name.padEnd(8)} `);
  for(let w=0;w<WINDOWS_N;w++){const p=simulateWindow(ds.symbol,ds.bars,wins[w].s,wins[w].e);allPnls[w].push(...p);process.stdout.write(`W${w+1}:${p.length} `);}
  console.log();
}

const results=wins.map((w,i)=>metrics(allPnls[i],w.label,new Date(ref[w.s]?.ts??0).toISOString().slice(0,10),new Date(ref[w.e-1]?.ts??0).toISOString().slice(0,10)));
const agg=metrics(allPnls.flat(),'AGRÉGÉ',results[0]?.from??'',results[WINDOWS_N-1]?.to??'');

console.log('\n══════════════════════════════════════════════ Walk-forward H4 cTrader ══');
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
console.log('  ─────────────────────────────────────────────────────────────────────────');
for(const r of results){
  const ic=r.expectancy>=CRITERIA.minExpectancy?'✅':r.expectancy<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${r.label.padEnd(10)} ${`${r.from} → ${r.to}`.padEnd(25)} ${r.trades.toString().padStart(6)}  ${(r.winRate*100).toFixed(0).padStart(4)}%  ${r.expectancy.toFixed(3).padStart(7)}  ${r.profitFactor.toFixed(2).padStart(5)}  ${r.maxDD.toFixed(1).padStart(5)}R`);
}
console.log('  ─────────────────────────────────────────────────────────────────────────');
console.log(`  ⭐ ${agg.label.padEnd(10)} ${`${agg.from} → ${agg.to}`.padEnd(25)} ${agg.trades.toString().padStart(6)}  ${(agg.winRate*100).toFixed(0).padStart(4)}%  ${agg.expectancy.toFixed(3).padStart(7)}  ${agg.profitFactor.toFixed(2).padStart(5)}  ${agg.maxDD.toFixed(1).padStart(5)}R`);

const pass=results.filter(r=>r.expectancy>=CRITERIA.minExpectancy).length;
const neg=(()=>{let m=0,c=0;for(const r of results){if(r.expectancy<0){c++;m=Math.max(m,c);}else c=0;}return m;})();
let verdict='';
if(agg.trades<CRITERIA.minTrades) verdict=`⚠️  INCONCLUSIVE — ${agg.trades} trades`;
else if(agg.expectancy<=0||neg>=CRITERIA.abandonNegConsec) verdict=`❌ ABANDON — E=${agg.expectancy.toFixed(3)}R, ${neg} fenêtres négatives consécutives`;
else if(pass>=CRITERIA.minWindows&&agg.profitFactor>=CRITERIA.minPF&&agg.winRate>=CRITERIA.minWR) verdict=`✅ EDGE CONFIRMÉ — E=${agg.expectancy.toFixed(3)}R | PF=${agg.profitFactor.toFixed(2)} | WR=${(agg.winRate*100).toFixed(0)}%`;
else verdict=`⚠️  EDGE MARGINAL — E=${agg.expectancy.toFixed(3)}R | PF=${agg.profitFactor.toFixed(2)} | ${pass}/${WINDOWS_N} fenêtres OK`;

console.log(`\n  Verdict H4 (données broker) : ${verdict}\n`);
fs.writeFileSync(path.join(DATA_DIR,'_h4_ctrader_walkforward.json'),JSON.stringify({generatedAt:Date.now(),strategy:DEFAULT_STRATEGY.name,criteria:CRITERIA,results,aggregate:agg,verdict},null,2));
