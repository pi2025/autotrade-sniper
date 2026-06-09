#!/usr/bin/env npx tsx
/**
 * scripts/validation/fetch-daily.ts
 * Récupère 5 ans de données Daily (1d) pour les 9 actifs cibles.
 * Yahoo Finance fournit jusqu'à 5+ ans de Daily sans restriction.
 * Usage : npx tsx scripts/validation/fetch-daily.ts
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const SYMBOLS = ['EURUSD=X','GBPUSD=X','USDJPY=X','USDCAD=X','NZDUSD=X','GBPJPY=X','EURCHF=X','GC=F','CL=F'];
const DELAY_MS = 1000;

interface OHLCVBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; interval: string; fetchedAt: number; fromDate: string; toDate: string; bars: OHLCVBar[]; }

function toLabel(ts: number) { return new Date(ts).toISOString().slice(0, 10); }

async function fetchDaily(symbol: string): Promise<OHLCVBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y&events=history&includeAdjustedClose=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const json: any = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) return [];
  const { timestamp, indicators } = result;
  const q = indicators.quote[0];
  const bars: OHLCVBar[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    bars.push({ ts: timestamp[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] ?? 0 });
  }
  return bars.sort((a, b) => a.ts - b.ts);
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`\n📊 Fetch Daily (5 ans) — ${SYMBOLS.length} actifs\n`);

  const summary: { symbol: string; bars: number; from: string; to: string }[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const bars = await fetchDaily(symbol);
      const safeName = symbol.replace(/[^a-zA-Z0-9]/g, '_');
      const data: HistoricalData = { symbol, interval: '1d', fetchedAt: Date.now(), fromDate: toLabel(bars[0]?.ts ?? 0), toDate: toLabel(bars[bars.length-1]?.ts ?? 0), bars };
      fs.writeFileSync(path.join(DATA_DIR, `${safeName}_1d.json`), JSON.stringify(data, null, 2));
      summary.push({ symbol, bars: bars.length, from: data.fromDate, to: data.toDate });
      const icon = bars.length >= 800 ? '✅' : '⚠️ ';
      console.log(`  ${icon} ${symbol.padEnd(12)} ${bars.length} barres  ${data.fromDate} → ${data.toDate}`);
    } catch (e: any) {
      console.error(`  ❌ ${symbol}: ${e.message}`);
      summary.push({ symbol, bars: 0, from: '-', to: '-' });
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const ready = summary.filter(s => s.bars >= 800).length;
  console.log(`\n→ ${ready}/${SYMBOLS.length} actifs prêts (≥800 barres daily pour walk-forward).\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
