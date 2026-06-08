#!/usr/bin/env npx tsx
/**
 * scripts/test-rls.ts — Vérifie que les policies RLS sont correctement configurées.
 * Usage : npx tsx scripts/test-rls.ts
 *
 * Pré-requis : VITE_SUPABASE_URL, VITE_SUPABASE_KEY, SUPABASE_SERVICE_KEY dans .env
 *
 * Tests :
 *   1. La clé anon NE PEUT PAS écrire dans signals
 *   2. La clé anon NE PEUT PAS écrire dans history
 *   3. La clé anon NE PEUT PAS écrire dans app_config
 *   4. La clé service_role PEUT écrire et supprimer dans signals
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

// Charge les vars depuis plusieurs fichiers possibles (le premier trouvé gagne)
config({ path: '.env' });
config({ path: '.env.local' });
config({ path: '.env.vercel.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const ANON_KEY     = process.env.VITE_SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('❌ Variables manquantes : VITE_SUPABASE_URL, VITE_SUPABASE_KEY, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const TEST_ID = `rls-test-${Date.now()}`;
let passed = 0;
let failed = 0;

function ok(label: string, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
  passed++;
}
function ko(label: string, detail = '') {
  console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
}

async function run() {
  const anon = createClient(SUPABASE_URL!, ANON_KEY!);
  const svc  = createClient(SUPABASE_URL!, SERVICE_KEY!, { auth: { persistSession: false } });

  console.log('\n🔒 Test RLS — AutoTrade Sniper V15\n');

  // --- Test 1 : anon ne peut pas insérer dans signals ---
  {
    const { error } = await anon.from('signals').insert({
      id: TEST_ID, asset: '__rls_test__', timeframe: 'M15', content: {},
    });
    if (error) {
      ok('anon INSERT signals bloqué', error.message);
    } else {
      ko('anon INSERT signals accepté (RLS manquant)');
      await svc.from('signals').delete().eq('id', TEST_ID); // nettoyage
    }
  }

  // --- Test 2 : anon ne peut pas insérer dans history ---
  {
    const { error } = await anon.from('history').insert({
      id: TEST_ID, asset: '__rls_test__', pnl: 0, content: {},
    });
    if (error) {
      ok('anon INSERT history bloqué', error.message);
    } else {
      ko('anon INSERT history accepté (RLS manquant)');
      await svc.from('history').delete().eq('id', TEST_ID);
    }
  }

  // --- Test 3 : anon ne peut pas upsert dans app_config ---
  {
    const { error } = await anon.from('app_config').upsert({ key: '__rls_test__', value: 'test' });
    if (error) {
      ok('anon UPSERT app_config bloqué', error.message);
    } else {
      ko('anon UPSERT app_config accepté (RLS manquant)');
      await svc.from('app_config').delete().eq('key', '__rls_test__');
    }
  }

  // --- Test 4 : service_role peut écrire et supprimer dans signals ---
  {
    const { error: insertErr } = await svc.from('signals').insert({
      id: TEST_ID, asset: '__rls_test__', timeframe: 'M15', content: {},
    });
    if (insertErr) {
      ko('service_role INSERT signals bloqué', insertErr.message);
    } else {
      const { error: deleteErr } = await svc.from('signals').delete().eq('id', TEST_ID);
      if (deleteErr) {
        ko('service_role DELETE signals bloqué', deleteErr.message);
      } else {
        ok('service_role INSERT + DELETE signals OK');
      }
    }
  }

  console.log(`\n--- ${passed + failed} tests | ${passed} ✅ | ${failed} ❌ ---`);
  if (failed > 0) {
    console.error('\n❌ RLS KO — appliquer supabase/migrations/003_rls_secure.sql avant de déployer\n');
    process.exit(1);
  } else {
    console.log('\n✅ RLS correct — la migration 003 peut être appliquée (ou l\'est déjà)\n');
  }
}

run().catch(e => { console.error('Erreur inattendue:', e); process.exit(1); });
