# Market Regime Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Valider une stratégie Market Regime Switching (V15 trend si ADX>25, RSI+BB mean reversion si ADX≤25) sur données cTrader H4 et Daily — et identifier la meilleure configuration pour le CEO.

**Architecture:** Deux sous-stratégies complémentaires sélectionnées par la valeur ADX à chaque barre. Les scripts de validation réutilisent `calculateIndicators()` de `marketEngine.ts` sans la modifier. Quatre scripts de validation séquentiels, chacun produisant un JSON de résultats.

**Tech Stack:** TypeScript + tsx, `@reiryoku/ctrader-layer`, `services/marketEngine.ts` (existant), données `scripts/validation/data/*_4h_ctrader.json` (déjà fetchées).

---

## Fichiers créés / modifiés

| Fichier | Rôle |
|---------|------|
| `scripts/validation/walk-forward-h4-mean-reversion.ts` | Étape 1 — MR seule sur H4 |
| `scripts/validation/walk-forward-h4-regime-switch.ts` | Étape 2 — V15+MR combinés sur H4 |
| `scripts/validation/fetch-ctrader-daily.ts` | Étape 3a — fetch Daily broker |
| `scripts/validation/walk-forward-daily-regime-switch.ts` | Étape 3b — V15+MR sur Daily |

Aucune modification de `services/marketEngine.ts` — on consomme uniquement `calculateIndicators` et `DEFAULT_STRATEGY`.

---

## Task 1 — Mean Reversion seule H4

**Fichier :** `scripts/validation/walk-forward-h4-mean-reversion.ts`

Valider que la logique RSI+BB mean reversion a un edge indépendant avant toute combinaison.

- [ ] **Créer le script walk-forward-h4-mean-reversion.ts**

```typescript
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

// Seuils mean reversion
const ADX_MAX_MR   = 25;    // régime range
const CHOP_MIN_MR  = 45;    // marché non-directionnel
const RSI_BUY      = 32;    // survente
const RSI_SELL     = 68;    // surachat
const BB_TOLERANCE = 0.3;   // ATR de marge sur la bande BB

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

    // Filtre régime : ADX ≤ 25 ET marché choppy
    if (ind.adx > ADX_MAX_MR)          continue;
    if (ind.choppiness <= CHOP_MIN_MR)  continue;

    // BUY : survente sur bande BB inférieure, prix au-dessus EMA200
    const buySignal  = ind.rsi < RSI_BUY
                    && price <= bb.lower + ind.atr * BB_TOLERANCE
                    && price > ind.ema200;

    // SELL : surachat sur bande BB supérieure, prix en dessous EMA200
    const sellSignal = ind.rsi > RSI_SELL
                    && price >= bb.upper - ind.atr * BB_TOLERANCE
                    && price < ind.ema200;

    if (!buySignal && !sellSignal) continue;

    const r = ind.atr * SL_MULT;
    if (r <= 0) continue;

    if (buySignal) {
      entry=price; sl=price-r; tp=bb.middle; // TP = EMA20 (retour à la moyenne)
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
```

- [ ] **Lancer le script**

```bash
npx tsx scripts/validation/walk-forward-h4-mean-reversion.ts
```

Résultat attendu : tableau avec 6 fenêtres OOS + AGRÉGÉ + verdict. Fichier `data/_h4_mr_results.json` créé.

- [ ] **Vérifier** : au moins 20 trades agrégés affichés. Si 0 trades → les seuils sont trop stricts, ajuster `RSI_BUY` de 32 → 35 et `ADX_MAX_MR` de 25 → 28.

- [ ] **Commit**

```bash
git add scripts/validation/walk-forward-h4-mean-reversion.ts
git commit -m "feat(validation): walk-forward H4 mean reversion RSI+BB"
```

---

## Task 2 — Regime Switch H4 (V15 + MR combinés)

**Fichier :** `scripts/validation/walk-forward-h4-regime-switch.ts`

- [ ] **Créer le script walk-forward-h4-regime-switch.ts**

```typescript
#!/usr/bin/env npx tsx
/**
 * walk-forward-h4-regime-switch.ts
 * Étape 2 — Market Regime Switching H4 cTrader.
 * ADX > 25  → TREND : V15 Sniper (Donchian breakout, logique originale)
 * ADX ≤ 25  → RANGE : Mean Reversion RSI+BB
 * Une position à la fois par actif.
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

// Trend params (V15)
const MAX_HOLD_TREND = 30;

// Mean reversion params
const MAX_HOLD_MR  = 20;
const SL_MULT_MR   = 1.5;
const ADX_MAX_MR   = 25;
const CHOP_MIN_MR  = 45;
const RSI_BUY      = 32;
const RSI_SELL     = 68;
const BB_TOLERANCE = 0.3;

const CRITERIA = { minExpectancy:0.10, minWindows:3, minPF:1.30, minWR:0.38, minTrades:50, abandonNegConsec:2 };

interface Bar { ts:number; open:number; high:number; low:number; close:number; volume:number; }
interface Dataset { symbol:string; name:string; bars:Bar[]; }

const files = fs.readdirSync(DATA_DIR).filter(f=>f.endsWith('_4h_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers H4'); process.exit(1); }

const datasets: Dataset[] = files.map(f=>{
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'));
  return { symbol:d.symbol, name:d.ctraderName, bars:d.bars };
}).filter(d=>d.bars.length >= LOOKBACK+100);

const ref = datasets[0].bars;
const bpw = Math.floor((ref.length - LOOKBACK) / WINDOWS_N);
const winDefs = Array.from({length:WINDOWS_N},(_,w)=>({
  label:`OOS-${w+1}`,
  from: new Date(ref[LOOKBACK+w*bpw]?.ts??0).toISOString().slice(0,10),
  to:   new Date(ref[LOOKBACK+(w+1)*bpw-1]?.ts??0).toISOString().slice(0,10),
  s: LOOKBACK+w*bpw, e: LOOKBACK+(w+1)*bpw,
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
      // Breakeven uniquement en mode TREND
      if (!be && maxHold===MAX_HOLD_TREND &&
          (type==='BUY'?closes[i]-entry:entry-closes[i]) >= risk*1.5) { sl=entry; be=true; }
      let closed=false, pnl=0;
      if (type==='BUY') {
        if(lows[i]<=sl)       { pnl=(sl-entry)/risk; closed=true; }
        else if(highs[i]>=tp) { pnl=(tp-entry)/risk; closed=true; }
      } else {
        if(highs[i]>=sl)      { pnl=(entry-sl)/risk; closed=true; }
        else if(lows[i]<=tp)  { pnl=(entry-tp)/risk; closed=true; }
      }
      if (!closed && hold >= maxHold) {
        pnl = type==='BUY'?(closes[i]-entry)/risk:(entry-closes[i])/risk;
        closed=true;
      }
      if (closed) { if(!isNaN(pnl)) pnls.push(pnl-TRADE_COST); inTrade=false; }
      continue;
    }

    const ws  = Math.max(0, i-LOOKBACK+1);
    const ind = calculateIndicators(
      closes.slice(ws,i+1), highs.slice(ws,i+1), lows.slice(ws,i+1),
      opens.slice(ws,i+1),  vols.slice(ws,i+1),  DEFAULT_STRATEGY, symbol
    );
    if (!ind) continue;

    const price = closes[i];
    const isTrend = ind.adx > ADX_MAX_MR;

    if (isTrend) {
      // ── TREND : logique V15 via analyzeMarket ──────────────────────────
      const { signal } = analyzeMarket(symbol, price, ind, DEFAULT_STRATEGY);
      if (!signal?.tradeSetup) continue;
      const r = Math.abs(price - signal.tradeSetup.stopLoss);
      if (r <= 0) continue;
      entry=price; sl=signal.tradeSetup.stopLoss; tp=signal.tradeSetup.takeProfit;
      type=signal.type===SignalType.BUY?'BUY':'SELL'; risk=r; hold=0; be=false;
      maxHold=MAX_HOLD_TREND; inTrade=true; trendN++;
    } else {
      // ── RANGE : Mean Reversion RSI+BB ──────────────────────────────────
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
  const n=pnls.length; if(!n) return {n:0,wr:0,e:0,pf:0,dd:0};
  const wins=pnls.filter(p=>p>0).length, wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0),
        lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0)), net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0; for(const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return {n,wr:wins/n,e:net/n,pf:lp>0?wp/lp:wp>0?99:0,dd};
}

const allWinPnls: number[][] = winDefs.map(()=>[]);
let totalTrend=0, totalMR=0;
for (const ds of datasets) {
  process.stdout.write(`  ▶ ${ds.name.padEnd(8)} `);
  for (let w=0;w<WINDOWS_N;w++) {
    const {pnls,trendN,mrN} = simulate(ds, winDefs[w].s, winDefs[w].e);
    allWinPnls[w].push(...pnls);
    totalTrend+=trendN; totalMR+=mrN;
    process.stdout.write(`W${w+1}:${pnls.length} `);
  }
  console.log();
}

const results = winDefs.map((w,i) => ({...metrics(allWinPnls[i]), label:w.label, from:w.from, to:w.to}));
const agg = {...metrics(allWinPnls.flat()), label:'AGRÉGÉ', from:winDefs[0].from, to:winDefs[WINDOWS_N-1].to};
const negC = (()=>{let m=0,c=0;for(const r of results){if(r.e<0){c++;m=Math.max(m,c);}else c=0;}return m;})();
const passing = results.filter(r=>r.e>=CRITERIA.minExpectancy).length;

console.log('\n══════════════════════════════════ Walk-forward H4 — Regime Switching ══');
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
if (agg.n < CRITERIA.minTrades)                                     verdict=`⚠️  INCONCLUSIVE — ${agg.n} trades`;
else if (agg.e<=0 || negC>=CRITERIA.abandonNegConsec)               verdict=`❌ ABANDON — E=${agg.e.toFixed(3)}R, ${negC} fenêtres négatives consécutives`;
else if (passing>=CRITERIA.minWindows && agg.pf>=CRITERIA.minPF
         && agg.wr>=CRITERIA.minWR)                                  verdict=`✅ EDGE CONFIRMÉ — E=${agg.e.toFixed(3)}R | PF=${agg.pf.toFixed(2)} | WR=${(agg.wr*100).toFixed(0)}%`;
else                                                                 verdict=`⚠️  EDGE MARGINAL — E=${agg.e.toFixed(3)}R | ${passing}/${WINDOWS_N} fenêtres OK`;

console.log(`\n  Verdict Regime Switch H4 : ${verdict}\n`);
fs.writeFileSync(path.join(DATA_DIR,'_h4_regime_switch_results.json'),
  JSON.stringify({generatedAt:Date.now(),source:'ctrader_h4',strategy:'regime_switch',criteria:CRITERIA,results,aggregate:agg,verdict,tradesMix:{trend:totalTrend,mr:totalMR},negConsec:negC},null,2));
```

- [ ] **Lancer le script**

```bash
npx tsx scripts/validation/walk-forward-h4-regime-switch.ts
```

Résultat attendu : tableau fenêtres + ligne Mix trades (Trend/MR) + verdict. Si verdict ✅ → on peut arrêter là et présenter au CEO. Si ❌ → continuer vers Daily.

- [ ] **Commit**

```bash
git add scripts/validation/walk-forward-h4-regime-switch.ts
git commit -m "feat(validation): walk-forward H4 regime switching V15+MR"
```

---

## Task 3a — Fetch Daily cTrader

**Fichier :** `scripts/validation/fetch-ctrader-daily.ts`

Période D1 = enum 12 dans l'API cTrader Spotware (confirmé : H1=9, H4=10, H12=11, D1=12).

- [ ] **Créer le script fetch-ctrader-daily.ts**

```typescript
#!/usr/bin/env npx tsx
// Fetch Daily (D1) cTrader broker data — 5 ans, 7 actifs
import { CTraderConnection } from '@reiryoku/ctrader-layer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
config({ path: '.env.vercel.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const CLIENT_ID     = process.env.CTRADER_CLIENT_ID!;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET!;
const ACCESS_TOKEN  = process.env.CTRADER_ACCESS_TOKEN!;
const ACCOUNT_ID    = parseInt(process.env.CTRADER_ACCOUNT_ID!);
const HOST = process.env.CTRADER_LIVE === 'true' ? 'live.ctraderapi.com' : 'demo.ctraderapi.com';
const PERIOD_D1 = 12; // cTrader enum D1

const TARGETS: Record<string, { name: string; digits: number }> = {
  'EURUSD=X': { name: 'EURUSD', digits: 5 },
  'GBPUSD=X': { name: 'GBPUSD', digits: 5 },
  'USDJPY=X': { name: 'USDJPY', digits: 3 },
  'USDCAD=X': { name: 'USDCAD', digits: 5 },
  'NZDUSD=X': { name: 'NZDUSD', digits: 5 },
  'GBPJPY=X': { name: 'GBPJPY', digits: 3 },
  'GC=F':     { name: 'XAUUSD', digits: 2 },
};

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }

function decode(raw: any[], digits: number): Bar[] {
  const f = Math.pow(10, -digits);
  return raw.filter(b=>b.utcTimestampInMinutes && b.low!=null).map(b=>{
    const lo=Number(b.low);
    return { ts:Number(b.utcTimestampInMinutes)*60000, low:lo*f, high:(lo+Number(b.deltaHigh??0))*f, open:(lo+Number(b.deltaOpen??0))*f, close:(lo+Number(b.deltaClose??0))*f, volume:Number(b.volume??0) };
  }).filter(b=>b.close>0);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`\n📊 Fetch D1 cTrader — ${Object.keys(TARGETS).length} actifs\n`);

const conn = new CTraderConnection({ host: HOST, port: 5035 });
const hb = setInterval(()=>conn.sendCommand('ProtoHeartbeatEvent',{}).catch(()=>{}), 10000);
const TIMEOUT = setTimeout(()=>{ console.error('TIMEOUT 5min'); process.exit(2); }, 300000);

await conn.open();
await conn.sendCommand('ProtoOAApplicationAuthReq', { clientId:CLIENT_ID, clientSecret:CLIENT_SECRET });
await conn.sendCommand('ProtoOAAccountAuthReq', { ctidTraderAccountId:ACCOUNT_ID, accessToken:ACCESS_TOKEN });

const symRes: any = await conn.sendCommand('ProtoOASymbolsListReq', { ctidTraderAccountId:ACCOUNT_ID });
const symIdMap = new Map<string,number>();
for (const s of (symRes.symbol??[])) if (s.symbolName&&s.symbolId) symIdMap.set(s.symbolName, s.symbolId);
console.log(`✅ Connecté — ${symIdMap.size} symboles\n`);

const nowMs      = Date.now();
const fiveYearsMs = nowMs - 5*365*24*3600*1000;
const chunkMs    = 4096 * 24 * 3600 * 1000; // 4096 jours par chunk — tout en 1-2 requêtes

const summary: any[] = [];
for (const [yahoo, { name, digits }] of Object.entries(TARGETS)) {
  const symbolId = symIdMap.get(name);
  if (!symbolId) { console.warn(`  ⚠️ ${name} non trouvé`); summary.push({yahoo,bars:0}); continue; }
  console.log(`▶ ${yahoo} (${name}  digits=${digits})`);
  const all: Bar[] = [];
  for (let from=fiveYearsMs; from<nowMs; from+=chunkMs) {
    try {
      const res: any = await conn.sendCommand('ProtoOAGetTrendbarsReq', { ctidTraderAccountId:ACCOUNT_ID, symbolId, period:PERIOD_D1, fromTimestamp:from, toTimestamp:Math.min(from+chunkMs,nowMs) });
      const bars = decode(res.trendbar??[], digits);
      all.push(...bars);
      process.stdout.write(`  ${bars.length}`);
    } catch { process.stdout.write(`  ERR`); }
    await new Promise(r=>setTimeout(r,300));
  }
  console.log();
  const seen = new Set<number>();
  const dedup = all.filter(b=>{if(seen.has(b.ts))return false;seen.add(b.ts);return true;}).sort((a,b)=>a.ts-b.ts);
  const from = dedup.length ? new Date(dedup[0].ts).toISOString().slice(0,10) : 'N/A';
  const to   = dedup.length ? new Date(dedup[dedup.length-1].ts).toISOString().slice(0,10) : 'N/A';
  const safe = yahoo.replace(/[^a-zA-Z0-9]/g,'_');
  fs.writeFileSync(path.join(DATA_DIR,`${safe}_d1_ctrader.json`), JSON.stringify({symbol:yahoo,ctraderName:name,interval:'d1',digits,source:'ctrader',fetchedAt:Date.now(),fromDate:from,toDate:to,bars:dedup},null,2));
  const icon = dedup.length>=1000?'✅':dedup.length>=400?'⚠️ ':'❌';
  console.log(`  ${icon} ${dedup.length} barres D1  ${from} → ${to}\n`);
  summary.push({yahoo,bars:dedup.length,from,to});
}

console.log('══════════ Résumé D1 ══════════');
for (const s of summary) console.log(`  ${s.bars>=1000?'✅':'⚠️ '} ${s.yahoo.padEnd(12)} ${String(s.bars).padStart(5)} barres  ${s.from??''} → ${s.to??''}`);
console.log(`\n→ Lancer : npx tsx scripts/validation/walk-forward-daily-regime-switch.ts\n`);

clearTimeout(TIMEOUT); clearInterval(hb); process.exit(0);
```

- [ ] **Lancer le fetch**

```bash
npx tsx scripts/validation/fetch-ctrader-daily.ts
```

Résultat attendu : 7 fichiers `*_d1_ctrader.json` créés, ~1200-1300 barres par actif (5 ans de trading days). Si < 400 barres → vérifier la connexion cTrader.

- [ ] **Commit**

```bash
git add scripts/validation/fetch-ctrader-daily.ts
git commit -m "feat(validation): fetch Daily D1 cTrader broker data"
```

---

## Task 3b — Regime Switch Daily

**Fichier :** `scripts/validation/walk-forward-daily-regime-switch.ts`

Paramètres adaptés au Daily : LOOKBACK=200, MAX_HOLD_TREND=20 barres D1, MAX_HOLD_MR=10 barres D1.

- [ ] **Créer le script walk-forward-daily-regime-switch.ts**

```typescript
#!/usr/bin/env npx tsx
/**
 * walk-forward-daily-regime-switch.ts
 * Étape 3b — Market Regime Switching sur Daily cTrader.
 * Mêmes règles que H4 mais paramètres adaptés au D1 :
 *   LOOKBACK=200  MAX_HOLD_TREND=20j  MAX_HOLD_MR=10j
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';
import { SignalType } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 200;
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

const files = fs.readdirSync(DATA_DIR).filter(f=>f.endsWith('_d1_ctrader.json')).sort();
if (!files.length) { console.error('❌ Pas de fichiers Daily — lancer fetch-ctrader-daily.ts'); process.exit(1); }

const datasets: Dataset[] = files.map(f=>{
  const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),'utf8'));
  return {symbol:d.symbol,name:d.ctraderName,bars:d.bars};
}).filter(d=>d.bars.length>=LOOKBACK+100);

const ref=datasets[0].bars;
const bpw=Math.floor((ref.length-LOOKBACK)/WINDOWS_N);
const winDefs=Array.from({length:WINDOWS_N},(_,w)=>({
  label:`OOS-${w+1}`,
  from:new Date(ref[LOOKBACK+w*bpw]?.ts??0).toISOString().slice(0,10),
  to:  new Date(ref[LOOKBACK+(w+1)*bpw-1]?.ts??0).toISOString().slice(0,10),
  s:LOOKBACK+w*bpw, e:LOOKBACK+(w+1)*bpw,
}));

function simulate(ds: Dataset, start: number, end: number): {pnls:number[];trendN:number;mrN:number} {
  const {symbol,bars}=ds;
  const closes=bars.map(b=>b.close),highs=bars.map(b=>b.high),lows=bars.map(b=>b.low),
        opens=bars.map(b=>b.open),vols=bars.map(b=>b.volume);
  const pnls:number[]=[]; let inTrade=false,entry=0,sl=0,tp=0,type='',hold=0,risk=0,be=false,maxHold=0;
  let trendN=0,mrN=0;

  for (let i=start;i<end;i++) {
    if (inTrade) {
      hold++;
      if (!be&&maxHold===MAX_HOLD_TREND&&(type==='BUY'?closes[i]-entry:entry-closes[i])>=risk*1.5){sl=entry;be=true;}
      let closed=false,pnl=0;
      if(type==='BUY'){if(lows[i]<=sl){pnl=(sl-entry)/risk;closed=true;}else if(highs[i]>=tp){pnl=(tp-entry)/risk;closed=true;}}
      else{if(highs[i]>=sl){pnl=(entry-sl)/risk;closed=true;}else if(lows[i]<=tp){pnl=(entry-tp)/risk;closed=true;}}
      if(!closed&&hold>=maxHold){pnl=type==='BUY'?(closes[i]-entry)/risk:(entry-closes[i])/risk;closed=true;}
      if(closed){if(!isNaN(pnl))pnls.push(pnl-TRADE_COST);inTrade=false;}
      continue;
    }
    const ws=Math.max(0,i-LOOKBACK+1);
    const ind=calculateIndicators(closes.slice(ws,i+1),highs.slice(ws,i+1),lows.slice(ws,i+1),opens.slice(ws,i+1),vols.slice(ws,i+1),DEFAULT_STRATEGY,symbol);
    if(!ind) continue;
    const price=closes[i];
    if(ind.adx>ADX_MAX_MR){
      const {signal}=analyzeMarket(symbol,price,ind,DEFAULT_STRATEGY);
      if(!signal?.tradeSetup) continue;
      const r=Math.abs(price-signal.tradeSetup.stopLoss);
      if(r<=0) continue;
      entry=price;sl=signal.tradeSetup.stopLoss;tp=signal.tradeSetup.takeProfit;
      type=signal.type===SignalType.BUY?'BUY':'SELL';risk=r;hold=0;be=false;maxHold=MAX_HOLD_TREND;inTrade=true;trendN++;
    } else {
      if(ind.choppiness<=CHOP_MIN_MR) continue;
      const bb=ind.bollingerBands;
      const buyOk=ind.rsi<RSI_BUY&&price<=bb.lower+ind.atr*BB_TOLERANCE&&price>ind.ema200;
      const sellOk=ind.rsi>RSI_SELL&&price>=bb.upper-ind.atr*BB_TOLERANCE&&price<ind.ema200;
      if(!buyOk&&!sellOk) continue;
      const r=ind.atr*SL_MULT_MR; if(r<=0) continue;
      if(buyOk){entry=price;sl=price-r;tp=bb.middle;type='BUY';}
      else{entry=price;sl=price+r;tp=bb.middle;type='SELL';}
      risk=r;hold=0;be=false;maxHold=MAX_HOLD_MR;inTrade=true;mrN++;
    }
  }
  return {pnls,trendN,mrN};
}

function metrics(pnls:number[]){
  const n=pnls.length;if(!n)return{n:0,wr:0,e:0,pf:0,dd:0};
  const wins=pnls.filter(p=>p>0).length,wp=pnls.filter(p=>p>0).reduce((s,p)=>s+p,0),
        lp=Math.abs(pnls.filter(p=>p<=0).reduce((s,p)=>s+p,0)),net=pnls.reduce((s,p)=>s+p,0);
  let pk=0,eq=0,dd=0;for(const p of pnls){eq+=p;if(eq>pk)pk=eq;dd=Math.max(dd,pk-eq);}
  return{n,wr:wins/n,e:net/n,pf:lp>0?wp/lp:wp>0?99:0,dd};
}

const allWinPnls:number[][]=winDefs.map(()=>[]);
let totalTrend=0,totalMR=0;
for(const ds of datasets){
  process.stdout.write(`  ▶ ${ds.name.padEnd(8)} `);
  for(let w=0;w<WINDOWS_N;w++){
    const{pnls,trendN,mrN}=simulate(ds,winDefs[w].s,winDefs[w].e);
    allWinPnls[w].push(...pnls);totalTrend+=trendN;totalMR+=mrN;
    process.stdout.write(`W${w+1}:${pnls.length} `);
  }
  console.log();
}

const results=winDefs.map((w,i)=>({...metrics(allWinPnls[i]),label:w.label,from:w.from,to:w.to}));
const agg={...metrics(allWinPnls.flat()),label:'AGRÉGÉ',from:winDefs[0].from,to:winDefs[WINDOWS_N-1].to};
const negC=(()=>{let m=0,c=0;for(const r of results){if(r.e<0){c++;m=Math.max(m,c);}else c=0;}return m;})();
const passing=results.filter(r=>r.e>=CRITERIA.minExpectancy).length;

console.log('\n══════════════════════════════ Walk-forward Daily — Regime Switching ══');
console.log(`  Mix trades → Trend: ${totalTrend} | MR: ${totalMR}`);
console.log('  Fenêtre    Période                    Trades  WR%    E(R)    PF     MaxDD');
console.log('  '+'─'.repeat(72));
for(const r of results){
  const ic=r.e>=CRITERIA.minExpectancy?'✅':r.e<0?'❌':'⚠️ ';
  console.log(`  ${ic} ${r.label.padEnd(10)} ${`${r.from} → ${r.to}`.padEnd(25)} ${String(r.n).padStart(5)}  ${((r.wr*100).toFixed(0)+'%').padStart(4)}  ${r.e.toFixed(3).padStart(7)}  ${r.pf.toFixed(2).padStart(5)}  ${r.dd.toFixed(1).padStart(5)}R`);
}
console.log('  '+'─'.repeat(72));
console.log(`  ⭐ ${agg.label.padEnd(10)} ${`${agg.from} → ${agg.to}`.padEnd(25)} ${String(agg.n).padStart(5)}  ${((agg.wr*100).toFixed(0)+'%').padStart(4)}  ${agg.e.toFixed(3).padStart(7)}  ${agg.pf.toFixed(2).padStart(5)}  ${agg.dd.toFixed(1).padStart(5)}R`);

let verdict='';
if(agg.n<CRITERIA.minTrades)                                        verdict=`⚠️  INCONCLUSIVE — ${agg.n} trades`;
else if(agg.e<=0||negC>=CRITERIA.abandonNegConsec)                  verdict=`❌ ABANDON — E=${agg.e.toFixed(3)}R, ${negC} fenêtres négatives consécutives`;
else if(passing>=CRITERIA.minWindows&&agg.pf>=CRITERIA.minPF&&agg.wr>=CRITERIA.minWR) verdict=`✅ EDGE CONFIRMÉ — E=${agg.e.toFixed(3)}R | PF=${agg.pf.toFixed(2)} | WR=${(agg.wr*100).toFixed(0)}%`;
else                                                                 verdict=`⚠️  EDGE MARGINAL — E=${agg.e.toFixed(3)}R | ${passing}/${WINDOWS_N} fenêtres OK`;

console.log(`\n  Verdict Regime Switch Daily : ${verdict}\n`);
fs.writeFileSync(path.join(DATA_DIR,'_daily_regime_switch_results.json'),
  JSON.stringify({generatedAt:Date.now(),source:'ctrader_d1',strategy:'regime_switch',criteria:CRITERIA,results,aggregate:agg,verdict,tradesMix:{trend:totalTrend,mr:totalMR},negConsec:negC},null,2));
```

- [ ] **Lancer le script**

```bash
npx tsx scripts/validation/walk-forward-daily-regime-switch.ts
```

- [ ] **Commit**

```bash
git add scripts/validation/fetch-ctrader-daily.ts scripts/validation/walk-forward-daily-regime-switch.ts
git commit -m "feat(validation): regime switch Daily D1 walk-forward"
```

---

## Task 4 — Verdict Final & Comparaison

- [ ] **Lire les 3 fichiers de résultats et comparer**

```bash
node -e "
const fs = require('fs');
const path = 'scripts/validation/data/';
const files = ['_h4_mr_results.json','_h4_regime_switch_results.json','_daily_regime_switch_results.json'];
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path+f,'utf8'));
    const a = d.aggregate;
    console.log(f.replace('_results.json','').replace('_','').padEnd(30), '| E:', d.aggregate.e?.toFixed(3), '| PF:', d.aggregate.pf?.toFixed(2), '| Trades:', d.aggregate.n, '| Verdict:', d.verdict?.slice(0,40));
  } catch(e) { console.log(f, 'manquant'); }
}
"
```

- [ ] **Décider la configuration à adopter** selon les critères :
  1. ✅ EDGE CONFIRMÉ → adopter directement
  2. ⚠️ MARGINAL → choisir la meilleure E(R) entre H4 et Daily
  3. ❌ ABANDON sur tous → présenter au CEO avec la recommandation d'attendre un régime favorable

- [ ] **Vérifier les résultats** avec `superpowers:verification-before-completion`

- [ ] **Commit final**

```bash
git add scripts/validation/
git commit -m "feat(validation): regime switching — verdict final H4 + Daily"
```

---

## Self-Review

- Spec coverage : ✅ Étapes 1-4 toutes couvertes, critères de succès définis, fichiers de sortie JSON nommés
- Placeholders : aucun TBD/TODO
- Cohérence types : `calculateIndicators` retourne `TechnicalIndicators | null`, les scripts vérifient `if (!ind) continue`
- ADX seuil : 25 pour le régime switch (>25 = TREND, ≤25 = RANGE) est cohérent dans tous les scripts
- `bb.middle` = EMA20 dans `calculateBollingerBands` (period=20) — confirmé dans `marketEngine.ts` ligne 131
