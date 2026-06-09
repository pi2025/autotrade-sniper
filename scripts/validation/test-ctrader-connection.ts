#!/usr/bin/env npx tsx
// Diagnostic : teste la connexion cTrader étape par étape
import { CTraderConnection } from '@reiryoku/ctrader-layer';
import { config } from 'dotenv';
config({ path: '.env.vercel.local' });

const HOST = 'demo.ctraderapi.com';
const PORT = 5035;
const CLIENT_ID     = process.env.CTRADER_CLIENT_ID!;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET!;

console.log('[1] Vars chargées:', { CLIENT_ID: CLIENT_ID?.slice(0,6)+'...', PORT });

const conn = new CTraderConnection({ host: HOST, port: PORT });

const TIMEOUT = setTimeout(() => {
  console.error('[X] TIMEOUT 15s — conn.open() ou sendCommand ne résoud jamais');
  process.exit(2);
}, 15_000);

try {
  console.log('[2] Appel conn.open()...');
  await conn.open();
  console.log('[3] open() résolu ✅');

  console.log('[4] Envoi APP_AUTH_REQ...');
  const authRes = await conn.sendCommand('ProtoOAApplicationAuthReq', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  console.log('[5] AUTH_RES:', JSON.stringify(authRes).slice(0, 300));

} catch(e: any) {
  console.error('[X] Erreur:', e?.message ?? e);
} finally {
  clearTimeout(TIMEOUT);
  process.exit(0);
}
