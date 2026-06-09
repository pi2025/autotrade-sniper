#!/usr/bin/env npx tsx
// Fetch H4 cTrader broker data — 2 ans, 9 actifs
// H4 = 4096 barres par chunk → ~682 jours → tout tient en 1-2 requêtes
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
const PERIOD_H4 = 10; // cTrader enum

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
  return raw.filter(b => b.utcTimestampInMinutes && b.low != null).map(b => {
    const lo = Number(b.low);
    return { ts: Number(b.utcTimestampInMinutes)*60000, low: lo*f, high: (lo+Number(b.deltaHigh??0))*f, open: (lo+Number(b.deltaOpen??0))*f, close: (lo+Number(b.deltaClose??0))*f, volume: Number(b.volume??0) };
  }).filter(b => b.close > 0);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`\n📊 Fetch H4 cTrader — ${Object.keys(TARGETS).length} actifs\n`);

const conn = new CTraderConnection({ host: HOST, port: 5035 });
const hb = setInterval(() => conn.sendCommand('ProtoHeartbeatEvent', {}).catch(()=>{}), 10000);
const TIMEOUT = setTimeout(() => { console.error('TIMEOUT 5min'); process.exit(2); }, 300000);

await conn.open();
await conn.sendCommand('ProtoOAApplicationAuthReq', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
await conn.sendCommand('ProtoOAAccountAuthReq', { ctidTraderAccountId: ACCOUNT_ID, accessToken: ACCESS_TOKEN });

const symRes: any = await conn.sendCommand('ProtoOASymbolsListReq', { ctidTraderAccountId: ACCOUNT_ID });
const symIdMap = new Map<string, number>();
for (const s of (symRes.symbol ?? [])) if (s.symbolName && s.symbolId) symIdMap.set(s.symbolName, s.symbolId);
console.log(`✅ Connecté — ${symIdMap.size} symboles\n`);

const nowMs = Date.now();
const twoYearsMs = nowMs - 5*365*24*3600*1000; // étendu à 5 ans
const chunkMs = 4096 * 4 * 3600 * 1000; // 4096 × 4h ≈ 682 jours

const summary: any[] = [];
for (const [yahoo, { name, digits }] of Object.entries(TARGETS)) {
  const symbolId = symIdMap.get(name);
  if (!symbolId) { console.warn(`  ⚠️ ${name} non trouvé`); summary.push({ yahoo, bars: 0 }); continue; }
  console.log(`▶ ${yahoo} (${name}  digits=${digits})`);
  const all: Bar[] = [];
  for (let from = twoYearsMs; from < nowMs; from += chunkMs) {
    try {
      const res: any = await conn.sendCommand('ProtoOAGetTrendbarsReq', { ctidTraderAccountId: ACCOUNT_ID, symbolId, period: PERIOD_H4, fromTimestamp: from, toTimestamp: Math.min(from+chunkMs, nowMs) });
      const bars = decode(res.trendbar ?? [], digits);
      all.push(...bars);
      process.stdout.write(`  ${bars.length}`);
    } catch(e: any) { process.stdout.write(`  ERR`); }
    await new Promise(r=>setTimeout(r, 300));
  }
  console.log();
  const seen = new Set<number>();
  const dedup = all.filter(b=>{if(seen.has(b.ts))return false;seen.add(b.ts);return true;}).sort((a,b)=>a.ts-b.ts);
  const from = dedup.length ? new Date(dedup[0].ts).toISOString().slice(0,10) : 'N/A';
  const to   = dedup.length ? new Date(dedup[dedup.length-1].ts).toISOString().slice(0,10) : 'N/A';
  const safe = yahoo.replace(/[^a-zA-Z0-9]/g,'_');
  fs.writeFileSync(path.join(DATA_DIR, `${safe}_4h_ctrader.json`), JSON.stringify({ symbol: yahoo, ctraderName: name, interval: '4h', digits, source: 'ctrader', fetchedAt: Date.now(), fromDate: from, toDate: to, bars: dedup }, null, 2));
  const icon = dedup.length >= 2000 ? '✅' : dedup.length >= 500 ? '⚠️ ' : '❌';
  console.log(`  ${icon} ${dedup.length} barres H4  ${from} → ${to}\n`);
  summary.push({ yahoo, bars: dedup.length, from, to });
}

console.log('══════════ Résumé H4 ══════════');
for (const s of summary) console.log(`  ${s.bars>=2000?'✅':'⚠️ '} ${s.yahoo.padEnd(12)} ${String(s.bars).padStart(5)} barres  ${s.from??''} → ${s.to??''}`);
console.log(`\n→ Lancer : npx tsx scripts/validation/walk-forward-ctrader-h4.ts\n`);

clearTimeout(TIMEOUT); clearInterval(hb); process.exit(0);
