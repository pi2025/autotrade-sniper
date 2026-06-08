#!/usr/bin/env npx tsx
/**
 * scripts/validation/fetch-historical.ts — Étape B1
 * Récupère N mois de bougies M15 depuis Yahoo Finance (direct, sans proxy CORS).
 * Les données sont sauvegardées dans scripts/validation/data/{symbol}.json (gitignored).
 *
 * Usage : npx tsx scripts/validation/fetch-historical.ts
 *
 * Stratégie de fetch :
 *   - Yahoo Finance limite les données M15 à ~60 jours par requête
 *   - On enchaîne des fenêtres glissantes de 59 jours pour couvrir MONTHS_BACK mois
 *   - Pause DELAY_MS entre requêtes pour éviter le rate-limiting
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

// Actifs cibles : les plus liquides de INITIAL_ASSETS, hors blacklist connue
const SYMBOLS = [
  'EURUSD=X',  // EUR/USD — le plus liquide
  'GBPUSD=X',  // GBP/USD
  'USDJPY=X',  // USD/JPY
  'USDCAD=X',  // USD/CAD
  'NZDUSD=X',  // NZD/USD
  'GBPJPY=X',  // GBP/JPY
  'EURCHF=X',  // EUR/CHF
  'GC=F',      // Gold (XAU/USD)
  'CL=F',      // WTI Oil
];

const MONTHS_BACK = 6;
const CHUNK_DAYS  = 59;   // max Yahoo M15 par requête (60 = parfois tronqué)
const DELAY_MS    = 1500; // pause entre chunks

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
  interval:  '15m';
  fetchedAt: number;
  fromDate:  string;
  toDate:    string;
  bars:      OHLCVBar[];
}

async function fetchChunk(symbol: string, period1: number, period2: number): Promise<OHLCVBar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(symbol)}?interval=15m&period1=${period1}&period2=${period2}&events=history`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });

  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) throw new Error(`http_${res.status}`);

  const json: any = await res.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) return [];

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

async function fetchWithRetry(symbol: string, period1: number, period2: number, retries = 2): Promise<OHLCVBar[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchChunk(symbol, period1, period2);
    } catch (e: any) {
      if (e.message === 'rate_limited') {
        const wait = (attempt + 1) * 10000;
        console.warn(`    ⏳ Rate limited — attente ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
  return [];
}

async function fetchSymbol(symbol: string): Promise<HistoricalData> {
  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - MONTHS_BACK * 30 * 24 * 3600;
  const chunkSec = CHUNK_DAYS * 24 * 3600;
  const allBars: OHLCVBar[] = [];

  for (let chunkStart = startSec; chunkStart < nowSec; chunkStart += chunkSec) {
    const chunkEnd = Math.min(chunkStart + chunkSec, nowSec);
    const fromLabel = new Date(chunkStart * 1000).toISOString().slice(0, 10);
    const toLabel   = new Date(chunkEnd   * 1000).toISOString().slice(0, 10);

    try {
      const bars = await fetchWithRetry(symbol, chunkStart, chunkEnd);
      allBars.push(...bars);
      console.log(`    ${fromLabel} → ${toLabel}  ${bars.length} barres`);
    } catch (e: any) {
      console.warn(`    ${fromLabel} → ${toLabel}  ERREUR: ${e.message}`);
    }

    if (chunkStart + chunkSec < nowSec) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // Déduplication par timestamp (chevauchements possibles aux frontières)
  const seen = new Set<number>();
  const deduplicated = allBars
    .filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
    .sort((a, b) => a.ts - b.ts);

  const fromDate = deduplicated.length > 0
    ? new Date(deduplicated[0].ts).toISOString().slice(0, 10)
    : 'N/A';
  const toDate = deduplicated.length > 0
    ? new Date(deduplicated[deduplicated.length - 1].ts).toISOString().slice(0, 10)
    : 'N/A';

  return { symbol, interval: '15m', fetchedAt: Date.now(), fromDate, toDate, bars: deduplicated };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`\n📊 Étape B1 — Fetch ${MONTHS_BACK} mois de M15 pour ${SYMBOLS.length} actifs`);
  console.log(`   Sortie : ${DATA_DIR}\n`);

  const summary: { symbol: string; bars: number; from: string; to: string; ok: boolean }[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n▶ ${symbol}`);
    try {
      const data = await fetchSymbol(symbol);
      const safeName = symbol.replace(/[^a-zA-Z0-9]/g, '_');
      const filePath = path.join(DATA_DIR, `${safeName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`  → ${data.bars.length} barres sauvegardées dans ${path.basename(filePath)}`);
      summary.push({ symbol, bars: data.bars.length, from: data.fromDate, to: data.toDate, ok: data.bars.length >= 2000 });
    } catch (e: any) {
      console.error(`  ❌ Échec : ${e.message}`);
      summary.push({ symbol, bars: 0, from: '-', to: '-', ok: false });
    }
  }

  console.log('\n\n══════════════════ Résumé B1 ══════════════════');
  console.log('Symbol       │  Barres │ Période');
  console.log('─────────────┼─────────┼─────────────────────────');
  for (const s of summary) {
    const icon = s.bars >= 5000 ? '✅' : s.bars >= 2000 ? '⚠️ ' : '❌';
    console.log(`${icon} ${s.symbol.padEnd(12)} │ ${s.bars.toString().padStart(6)}  │ ${s.from} → ${s.to}`);
  }
  console.log('\n✅ ≥ 5 000 barres  |  ⚠️  2 000–5 000  |  ❌ < 2 000 (insuffisant pour walk-forward)');

  const insufficients = summary.filter(s => s.bars < 2000 && s.bars > 0);
  const failures      = summary.filter(s => s.bars === 0);
  if (failures.length > 0) {
    console.warn(`\n⚠️  ${failures.length} actif(s) n'ont retourné aucune donnée — vérifier la connectivité ou le symbole.`);
  }
  if (insufficients.length > 0) {
    console.warn(`⚠️  ${insufficients.length} actif(s) sous le seuil — le walk-forward sera peu fiable pour ces actifs.`);
  }

  const ready = summary.filter(s => s.bars >= 5000).length;
  console.log(`\n→ ${ready}/${SYMBOLS.length} actifs prêts pour le walk-forward. Montrer ce résumé au CEO avant de continuer vers B2.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
