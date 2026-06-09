#!/usr/bin/env npx tsx
/**
 * scripts/validation/fetch-historical.ts — Étape B1
 *
 * Yahoo Finance limites réelles :
 *   15m  → max 60 jours (une seule requête range=60d)
 *   1h   → max 730 jours (~2 ans, requêtes glissantes de 60j)
 *
 * Stratégie :
 *   - M15  : 60j de données pour validation récente (ordres de grandeur, qualité d'entrée)
 *   - H1   : ~2 ans pour le walk-forward multi-fenêtres (statistiquement fiable)
 *
 * Usage : npx tsx scripts/validation/fetch-historical.ts
 * Sortie : scripts/validation/data/{symbol}_{interval}.json  (gitignored)
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// Actifs cibles — les plus liquides hors blacklist connue
const SYMBOLS = [
  'EURUSD=X',
  'GBPUSD=X',
  'USDJPY=X',
  'USDCAD=X',
  'NZDUSD=X',
  'GBPJPY=X',
  'EURCHF=X',
  'GC=F',    // Gold
  'CL=F',    // WTI Oil
];

const DELAY_MS = 1200; // pause polie entre requêtes

interface OHLCVBar {
  ts:     number; // Unix ms
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface HistoricalData {
  symbol:    string;
  interval:  string;
  fetchedAt: number;
  fromDate:  string;
  toDate:    string;
  bars:      OHLCVBar[];
  note?:     string;
}

// --- Fetch via paramètre `range` (M15, max 60d) ---
async function fetchByRange(symbol: string, interval: string, range: string): Promise<OHLCVBar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&events=history&includeAdjustedClose=true`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`http_${res.status}`);

  const json: any = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) return [];

  return parseYahooBars(result);
}

// --- Fetch via period1/period2 (H1, fenêtres glissantes) ---
async function fetchByPeriod(symbol: string, interval: string, period1: number, period2: number): Promise<OHLCVBar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&period1=${period1}&period2=${period2}&events=history`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) throw new Error(`http_${res.status}`);

  const json: any = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) return [];

  return parseYahooBars(result);
}

function parseYahooBars(result: any): OHLCVBar[] {
  const { timestamp, indicators } = result;
  const q = indicators.quote[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) continue;
    bars.push({
      ts:     timestamp[i] * 1000,
      open:   q.open[i],
      high:   q.high[i],
      low:    q.low[i],
      close:  q.close[i],
      volume: q.volume?.[i] ?? 0,
    });
  }
  return bars;
}

function deduplicate(bars: OHLCVBar[]): OHLCVBar[] {
  const seen = new Set<number>();
  return bars
    .filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
    .sort((a, b) => a.ts - b.ts);
}

function toLabel(ts: number) { return new Date(ts).toISOString().slice(0, 10); }

// --- M15 : une requête range=60d ---
async function fetchM15(symbol: string): Promise<HistoricalData> {
  console.log(`  [M15] range=60d`);
  const bars = await fetchByRange(symbol, '15m', '60d');
  const dedup = deduplicate(bars);
  return {
    symbol, interval: '15m', fetchedAt: Date.now(),
    fromDate: dedup.length ? toLabel(dedup[0].ts) : 'N/A',
    toDate:   dedup.length ? toLabel(dedup[dedup.length - 1].ts) : 'N/A',
    bars: dedup,
    note: 'Yahoo Finance limite 15m à 60 jours — walk-forward M15 non faisable sur cette seule source.',
  };
}

// --- H1 : fenêtres glissantes de 60j sur 2 ans ---
async function fetchH1(symbol: string): Promise<HistoricalData> {
  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 730 * 24 * 3600; // ~2 ans
  const chunkSec = 60 * 24 * 3600;
  const allBars: OHLCVBar[] = [];

  let chunks = 0;
  for (let t = startSec; t < nowSec; t += chunkSec) {
    const end = Math.min(t + chunkSec, nowSec);
    try {
      const bars = await fetchByPeriod(symbol, '1h', t, end);
      allBars.push(...bars);
      chunks++;
      process.stdout.write('.');
    } catch (e: any) {
      if (e.message === 'rate_limited') {
        console.warn('\n    Rate limited — attente 15s...');
        await new Promise(r => setTimeout(r, 15000));
        try { allBars.push(...await fetchByPeriod(symbol, '1h', t, end)); chunks++; process.stdout.write('.'); }
        catch { process.stdout.write('x'); }
      } else {
        process.stdout.write('x');
      }
    }
    if (t + chunkSec < nowSec) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(` (${chunks} chunks)`);

  const dedup = deduplicate(allBars);
  return {
    symbol, interval: '1h', fetchedAt: Date.now(),
    fromDate: dedup.length ? toLabel(dedup[0].ts) : 'N/A',
    toDate:   dedup.length ? toLabel(dedup[dedup.length - 1].ts) : 'N/A',
    bars: dedup,
  };
}

function saveData(data: HistoricalData) {
  const safeName = data.symbol.replace(/[^a-zA-Z0-9]/g, '_');
  const filePath = path.join(DATA_DIR, `${safeName}_${data.interval}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`\n📊 Étape B1 — Fetch données historiques pour ${SYMBOLS.length} actifs`);
  console.log(`   Sortie : ${DATA_DIR}\n`);
  console.log('⚠️  Yahoo Finance : M15 limité à 60j | H1 disponible sur ~2 ans\n');

  type Row = { symbol: string; m15: number; h1: number; from: string; to: string };
  const summary: Row[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n▶ ${symbol}`);
    let m15Bars = 0, h1Bars = 0, fromDate = '-', toDate = '-';

    // M15
    try {
      const data = await fetchM15(symbol);
      saveData(data);
      m15Bars = data.bars.length;
      console.log(`  M15 → ${m15Bars} barres  (${data.fromDate} → ${data.toDate})`);
    } catch (e: any) {
      console.error(`  M15 erreur: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));

    // H1
    try {
      process.stdout.write(`  [H1] 2 ans de fenêtres 60j `);
      const data = await fetchH1(symbol);
      saveData(data);
      h1Bars = data.bars.length;
      fromDate = data.fromDate;
      toDate = data.toDate;
      console.log(`  H1  → ${h1Bars} barres  (${data.fromDate} → ${data.toDate})`);
    } catch (e: any) {
      console.error(`  H1 erreur: ${e.message}`);
    }

    summary.push({ symbol, m15: m15Bars, h1: h1Bars, from: fromDate, to: toDate });
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log('\n\n══════════════════════════════════════════ Résumé B1 ══');
  console.log('Symbol         M15 (60j)    H1 (~2 ans)   Période H1');
  console.log('─────────────────────────────────────────────────────────');
  for (const s of summary) {
    const m15Icon = s.m15 >= 2000 ? '✅' : s.m15 >= 500 ? '⚠️ ' : '❌';
    const h1Icon  = s.h1  >= 5000 ? '✅' : s.h1  >= 2000 ? '⚠️ ' : '❌';
    console.log(
      `${s.symbol.padEnd(14)} ${m15Icon} ${s.m15.toString().padStart(5)}     ` +
      `${h1Icon} ${s.h1.toString().padStart(6)}   ${s.from} → ${s.to}`
    );
  }

  const h1Ready = summary.filter(s => s.h1 >= 5000).length;
  console.log(`\n→ ${h1Ready}/${SYMBOLS.length} actifs avec H1 suffisant pour walk-forward.`);
  console.log('→ Walk-forward sera sur H1 (~2 ans). M15 60j pour validation récente uniquement.');
  console.log('\nMontrer ce résumé au CEO avant de continuer vers B2.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
