#!/usr/bin/env npx tsx
/**
 * scripts/validation/fetch-ctrader-history.ts — Piste 2
 *
 * Récupère l'historique OHLCV H1 directement depuis le broker cTrader
 * via l'API Spotware (ProtoOAGetTrendbarsReq).
 *
 * Avantages vs Yahoo Finance :
 *   - Prix réels du broker (mid bid/ask IC Markets)
 *   - Données brutes Protobuf, pas de proxy tiers
 *   - Qualité et timestamps exacts
 *
 * Usage : npx tsx scripts/validation/fetch-ctrader-history.ts
 * Pré-requis : CTRADER_* dans .env ou .env.vercel.local
 * Sortie : scripts/validation/data/{symbol}_1h_ctrader.json
 */

import { CTraderConnection } from '@reiryoku/ctrader-layer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config();
config({ path: '.env.vercel.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const CLIENT_ID     = process.env.CTRADER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';
const ACCESS_TOKEN  = process.env.CTRADER_ACCESS_TOKEN || '';
const ACCOUNT_ID    = parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
const IS_LIVE       = process.env.CTRADER_LIVE === 'true';
const HOST = IS_LIVE ? 'live.ctraderapi.com' : 'demo.ctraderapi.com';
const PORT = 5035;

const PT = {
  HEARTBEAT:        'ProtoHeartbeatEvent',
  APP_AUTH_REQ:     'ProtoOAApplicationAuthReq',
  ACCOUNT_AUTH_REQ: 'ProtoOAAccountAuthReq',
  SYMBOLS_LIST_REQ: 'ProtoOASymbolsListReq',
  SYMBOL_BY_ID_REQ: 'ProtoOASymbolByIdReq',
  TRENDBARS_REQ:    'ProtoOAGetTrendbarsReq',
} as const;

// cTrader period enum — H1 = 9
const PERIOD_H1 = 9;

// Actifs cibles : Yahoo → cTrader name (cf. SYMBOL_MAP dans ctraderService.ts)
const TARGETS: Record<string, string> = {
  'EURUSD=X': 'EURUSD',
  'GBPUSD=X': 'GBPUSD',
  'USDJPY=X': 'USDJPY',
  'USDCAD=X': 'USDCAD',
  'NZDUSD=X': 'NZDUSD',
  'GBPJPY=X': 'GBPJPY',
  'GC=F':     'XAUUSD',
};

interface OHLCVBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }

function decodeBars(raw: any[], digits: number): OHLCVBar[] {
  const f = Math.pow(10, -digits);
  return raw
    .filter(b => b.utcTimestampInMinutes && b.low != null)
    .map(b => {
      // La lib retourne les valeurs comme strings — forcer Number avant toute arithmétique
      // pour éviter la concaténation de chaînes ("115390" + "51" = "11539051" ≠ 115441)
      const rawLow = Number(b.low);
      return {
        ts:     Number(b.utcTimestampInMinutes) * 60 * 1000,
        low:    rawLow * f,
        high:   (rawLow + Number(b.deltaHigh  ?? 0)) * f,
        open:   (rawLow + Number(b.deltaOpen  ?? 0)) * f,
        close:  (rawLow + Number(b.deltaClose ?? 0)) * f,
        volume: Number(b.volume ?? 0),
      };
    })
    .filter(b => b.close > 0);
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN || !ACCOUNT_ID) {
    console.error('❌ Variables CTRADER_* manquantes. Vérifier .env ou .env.vercel.local.');
    process.exit(1);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`\n📊 Fetch historique cTrader (${IS_LIVE ? '🔴 LIVE' : '🟡 DEMO'}) — H1 ~2 ans`);
  console.log(`   Connexion : ${HOST}:${PORT}...\n`);

  const conn = new CTraderConnection({ host: HOST, port: PORT });
  const hb = setInterval(() => conn.sendCommand(PT.HEARTBEAT, {}).catch(() => {}), 10_000);

  try {
    await conn.open();
    await conn.sendCommand(PT.APP_AUTH_REQ,     { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await conn.sendCommand(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ACCOUNT_ID, accessToken: ACCESS_TOKEN });

    const symRes: any = await conn.sendCommand(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: ACCOUNT_ID });
    const symIdMap = new Map<string, number>();
    for (const s of (symRes.symbol ?? [])) {
      if (s.symbolName && s.symbolId) symIdMap.set(s.symbolName, s.symbolId);
    }
    console.log(`✅ Connecté — ${symIdMap.size} symboles disponibles\n`);

    const nowMs        = Date.now();
    const twoYearsMs   = nowMs - 2 * 365 * 24 * 3600 * 1000;
    const chunkMs      = 4096 * 3600 * 1000; // ~170 jours par chunk (4096 barres H1 max)

    const summary: { symbol: string; bars: number; from: string; to: string }[] = [];

    for (const [yahoo, ctraderName] of Object.entries(TARGETS)) {
      const symbolId = symIdMap.get(ctraderName);
      if (!symbolId) {
        console.warn(`  ⚠️  ${yahoo} (${ctraderName}) — non trouvé dans la liste des symboles`);
        summary.push({ symbol: yahoo, bars: 0, from: '-', to: '-' });
        continue;
      }

      // Récupérer les digits du symbole pour le décodage des prix
      let digits = 5;
      try {
        const dRes: any = await conn.sendCommand(PT.SYMBOL_BY_ID_REQ, {
          ctidTraderAccountId: ACCOUNT_ID,
          symbolId: [symbolId],
        });
        digits = dRes.symbol?.[0]?.digits ?? 5;
      } catch { /* garder la valeur par défaut */ }

      console.log(`▶ ${yahoo} (${ctraderName}  id=${symbolId}  digits=${digits})`);
      const allBars: OHLCVBar[] = [];

      for (let from = twoYearsMs; from < nowMs; from += chunkMs) {
        const to = Math.min(from + chunkMs, nowMs);
        try {
          const res: any = await conn.sendCommand(PT.TRENDBARS_REQ, {
            ctidTraderAccountId: ACCOUNT_ID,
            symbolId,
            period: PERIOD_H1,
            fromTimestamp: from,
            toTimestamp:   to,
          });
          const bars = decodeBars(res.trendbar ?? [], digits);
          allBars.push(...bars);
          process.stdout.write(`  ${bars.length}`);
        } catch (e: any) {
          process.stdout.write(`  ERR(${e.message.slice(0,20)})`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      console.log();

      // Déduplication + tri
      const seen = new Set<number>();
      const dedup = allBars
        .filter(b => { if (seen.has(b.ts)) return false; seen.add(b.ts); return true; })
        .sort((a, b) => a.ts - b.ts);

      const fromDate = dedup.length ? new Date(dedup[0].ts).toISOString().slice(0,10) : 'N/A';
      const toDate   = dedup.length ? new Date(dedup[dedup.length-1].ts).toISOString().slice(0,10) : 'N/A';

      const safeName = yahoo.replace(/[^a-zA-Z0-9]/g, '_');
      const outPath  = path.join(DATA_DIR, `${safeName}_1h_ctrader.json`);
      fs.writeFileSync(outPath, JSON.stringify({ symbol: yahoo, ctraderName, interval: '1h', digits, source: 'ctrader', fetchedAt: Date.now(), fromDate, toDate, bars: dedup }, null, 2));

      const icon = dedup.length >= 5000 ? '✅' : dedup.length >= 2000 ? '⚠️ ' : '❌';
      console.log(`  ${icon} ${dedup.length} barres H1  ${fromDate} → ${toDate}  → ${path.basename(outPath)}\n`);
      summary.push({ symbol: yahoo, bars: dedup.length, from: fromDate, to: toDate });
    }

    console.log('══════════ Résumé ══════════');
    for (const s of summary) {
      const icon = s.bars >= 5000 ? '✅' : s.bars >= 2000 ? '⚠️ ' : '❌';
      console.log(`  ${icon} ${s.symbol.padEnd(12)} ${s.bars.toString().padStart(6)} barres  ${s.from} → ${s.to}`);
    }
    const ready = summary.filter(s => s.bars >= 5000).length;
    console.log(`\n→ ${ready}/${Object.keys(TARGETS).length} actifs prêts pour walk-forward.`);
    console.log('→ Lancer : npx tsx scripts/validation/walk-forward-ctrader.ts\n');

  } catch (e: any) {
    console.error('\n❌ Erreur dans fetch-ctrader-history:', e?.message ?? String(e));
    throw e;
  } finally {
    clearInterval(hb);
    // Node.js quitte naturellement une fois l'event loop vide
  }
}

main().catch(e => { console.error('Détail:', e); process.exit(1); });
