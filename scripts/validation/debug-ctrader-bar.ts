#!/usr/bin/env npx tsx
// Affiche le format brut d'une barre cTrader pour corriger le décodage
import { CTraderConnection } from '@reiryoku/ctrader-layer';
import { config } from 'dotenv';
config({ path: '.env.vercel.local' });

const conn = new CTraderConnection({ host: 'demo.ctraderapi.com', port: 5035 });
const TIMEOUT = setTimeout(() => { console.error('TIMEOUT 20s'); process.exit(2); }, 20000);

await conn.open();
await conn.sendCommand('ProtoOAApplicationAuthReq', { clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET });
await conn.sendCommand('ProtoOAAccountAuthReq', { ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!), accessToken: process.env.CTRADER_ACCESS_TOKEN });

const now = Date.now();
// Fetch last 5 H1 bars for EURUSD (symbolId=1)
const res: any = await conn.sendCommand('ProtoOAGetTrendbarsReq', {
  ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
  symbolId: 1,
  period: 9, // H1
  fromTimestamp: now - 6 * 3600 * 1000,
  toTimestamp: now,
});

const bars = res.trendbar ?? [];
console.log('Nb barres reçues:', bars.length);
bars.slice(0, 3).forEach((b: any, i: number) => {
  console.log(`\nBar[${i}] raw:`, JSON.stringify(b));
  // Tentative de décodage
  if (b.low != null) {
    const f5 = Math.pow(10, -5);
    console.log(`  low*1e-5=${b.low * f5}  open=(low+dOpen)*1e-5=${(b.low + (b.deltaOpen??0)) * f5}  high=(low+dHigh)*1e-5=${(b.low + (b.deltaHigh??0)) * f5}`);
  }
});

clearTimeout(TIMEOUT);
process.exit(0);
