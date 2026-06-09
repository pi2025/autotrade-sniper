#!/usr/bin/env npx tsx
/**
 * scripts/test-economic-filter.ts — Vérifie que isHighImpactEventSoon retourne
 * le bon format et ne plante pas pour les différents types d'actifs.
 * Usage : npx tsx scripts/test-economic-filter.ts
 */

import { config } from 'dotenv';
config({ path: '.env' });
config({ path: '.env.vercel.local' });

import { isHighImpactEventSoon } from '../services/economicCalendarService';

let passed = 0;
let failed = 0;

function ok(label: string) { console.log(`  ✅ ${label}`); passed++; }
function fail(label: string, detail?: any) { console.error(`  ❌ ${label}`, detail ?? ''); failed++; }

async function main() {
  console.log('\n📅 Test du filtre économique\n');

  // Test 1 — Actif forex USD mappé : doit retourner { isSoon: boolean, events: array }
  console.log('Test 1 : EURUSD=X — retour bien formé');
  const r1 = await isHighImpactEventSoon('EURUSD=X', 60);
  if (typeof r1.isSoon === 'boolean' && Array.isArray(r1.events)) ok('retour formé { isSoon, events }');
  else fail('retour malformé', r1);

  // Test 2 — Actif non mappé : doit retourner { isSoon: false, events: [] }
  console.log('Test 2 : UNKNOWN=X — doit retourner isSoon=false');
  const r2 = await isHighImpactEventSoon('UNKNOWN=X', 60);
  if (r2.isSoon === false && r2.events.length === 0) ok('isSoon=false, events=[] pour actif inconnu');
  else fail('inattendu pour actif inconnu', r2);

  // Test 3 — Chaque événement doit avoir title, currency, minutesUntil
  console.log('Test 3 : Structure des événements retournés');
  const r3 = await isHighImpactEventSoon('GBPUSD=X', 60 * 24 * 7);
  const malformed = r3.events.filter(e => typeof e.title !== 'string' || typeof e.currency !== 'string' || typeof e.minutesUntil !== 'number');
  if (malformed.length === 0) ok(`${r3.events.length} événements bien formés`);
  else fail(`${malformed.length} événements malformés`, malformed[0]);

  console.log(`\n${passed} passés, ${failed} échoués`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
