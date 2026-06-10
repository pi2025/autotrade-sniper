#!/usr/bin/env npx tsx
/**
 * scripts/test-ctrader-order.ts — Test minimal de placement d'ordre cTrader
 * Usage : npx tsx scripts/test-ctrader-order.ts
 */

import { config } from 'dotenv';
config({ path: '.env' });
config({ path: '.env.vercel.local' });

import { CTraderConnection } from '@reiryoku/ctrader-layer';

const CLIENT_ID     = process.env.CTRADER_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';
const ACCESS_TOKEN  = process.env.CTRADER_ACCESS_TOKEN  || '';
const ACCOUNT_ID    = parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
const HOST          = process.env.CTRADER_HOST || 'demo.ctraderapi.com';
const PORT          = 5035;

async function main() {
  console.log(`\n🔌 Connexion à ${HOST}:${PORT}...\n`);

  const conn = new CTraderConnection({ host: HOST, port: PORT });

  // ─── Intercepter TOUS les messages entrants ────────────────────────────
  const origGetName = conn.getPayloadNameByType.bind(conn);
  (conn as any).getPayloadNameByType = function(type: any) {
    const name = origGetName(type);
    console.log(`📨 [RAW IN] payloadType=${type} → name=${name}`);
    return name;
  };
  // ───────────────────────────────────────────────────────────────────────

  await conn.open();
  console.log('✅ Connexion TCP/TLS établie');

  // App auth
  const appRes: any = await conn.sendCommand('ProtoOAApplicationAuthReq', {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  console.log('✅ App auth:', JSON.stringify(appRes));

  // Account auth
  const accRes: any = await conn.sendCommand('ProtoOAAccountAuthReq', {
    ctidTraderAccountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
  });
  console.log('✅ Account auth:', JSON.stringify(accRes));

  // Trader info complète
  const traderRes: any = await conn.sendCommand('ProtoOATraderReq', { ctidTraderAccountId: ACCOUNT_ID });
  const balance = (traderRes.trader?.balance ?? 0) / 100;
  console.log(`✅ Balance: $${balance.toFixed(2)}`);
  console.log('ℹ️  Trader complet:', JSON.stringify(traderRes.trader, null, 2));

  // Symbols — trouver NZDUSD + minVolume/stepVolume
  const symRes: any = await conn.sendCommand('ProtoOASymbolsListReq', { ctidTraderAccountId: ACCOUNT_ID });
  const symbols = symRes.symbol ?? [];
  const nzdusd = symbols.find((s: any) => s.symbolName === 'NZDUSD');
  console.log(`✅ NZDUSD symbolId=${nzdusd?.symbolId}, minVolume=${nzdusd?.minVolume}, stepVolume=${nzdusd?.stepVolume}, maxVolume=${nzdusd?.maxVolume}`);

  const symbolId = nzdusd?.symbolId;
  if (!symbolId) { console.error('❌ NZDUSD non trouvé'); process.exit(1); }

  const minVol = nzdusd?.minVolume ?? 100000; // 100000 = 1 lot (minimum ICMarkets demo)
  console.log(`ℹ️  Volume utilisé: ${minVol} (= ${minVol/100000} lot)`);

  // Écouter tous les push events nommés
  conn.on('ProtoOAExecutionEvent', (event: any) => {
    console.log('\n🎯 EXECUTION EVENT:', JSON.stringify(event.descriptor, null, 2));
  });
  conn.on('ProtoOAOrderErrorEvent', (event: any) => {
    console.log('\n❌ ORDER ERROR EVENT:', JSON.stringify(event.descriptor, null, 2));
  });
  conn.on('ProtoOAErrorRes', (event: any) => {
    console.log('\n❌ ERROR RES EVENT:', JSON.stringify(event.descriptor, null, 2));
  });

  // Positions avant
  const beforeRec: any = await conn.sendCommand('ProtoOAReconcileReq', { ctidTraderAccountId: ACCOUNT_ID });
  console.log(`\n📋 Positions avant ordre: ${(beforeRec.position ?? []).length}`);

  // Envoyer l'ordre avec le minVolume du symbole
  // SL/TP relatifs : 50 pips SL, 100 pips TP (en 1/100000 d'unité de prix)
  const relativeStopLoss  = 50 * 10;   // 50 pips × 10 (NZDUSD 5 digits)
  const relativeTakeProfit = 100 * 10; // 100 pips × 10

  console.log(`\n📤 Envoi NEW_ORDER_REQ: NZDUSD symbolId=${symbolId} volume=${minVol} BUY MARKET SL=${relativeStopLoss} TP=${relativeTakeProfit} (relatifs)...`);
  try {
    const orderRes: any = await conn.sendCommand('ProtoOANewOrderReq', {
      ctidTraderAccountId: ACCOUNT_ID,
      symbolId,
      orderType: 1, // MARKET
      tradeSide: 1, // BUY
      volume: minVol,
      relativeStopLoss,
      relativeTakeProfit,
    });
    console.log('📥 sendCommand retourne:', JSON.stringify(orderRes));
  } catch (err: any) {
    console.error('❌ sendCommand a rejeté:', JSON.stringify(err));
  }

  // Attendre 8s pour voir si un event arrive
  console.log('\n⏳ Attente 8s pour voir les events...');
  await new Promise(r => setTimeout(r, 8000));

  // Positions après
  const afterRec: any = await conn.sendCommand('ProtoOAReconcileReq', { ctidTraderAccountId: ACCOUNT_ID });
  const afterPositions = afterRec.position ?? [];
  console.log(`\n📋 Positions après ordre: ${afterPositions.length}`);
  if (afterPositions.length > 0) {
    console.log('Positions:', JSON.stringify(afterPositions.map((p: any) => ({
      positionId: p.positionId,
      symbolId: p.tradeData?.symbolId,
      volume: p.tradeData?.volume,
      side: p.tradeData?.tradeSide,
    })), null, 2));
  }

  console.log('\n✅ Test terminé');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Erreur fatale:', e);
  process.exit(1);
});
