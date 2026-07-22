#!/usr/bin/env npx tsx
/**
 * scripts/test-ctrader-deals.ts — Test manuel de getClosedDeals()
 * Usage : npx tsx scripts/test-ctrader-deals.ts [jours]
 */

import { config } from 'dotenv';
config({ path: '.env' });
config({ path: '.env.vercel.local' });

async function main() {
  // Import dynamique : les imports statiques sont hoistés en ESM et s'évalueraient
  // avant les config() ci-dessus, donc ctraderService lirait des env vars vides.
  const { getClosedDeals } = await import('../services/ctraderService.ts');

  const days = parseInt(process.argv[2] || '9', 10);
  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60 * 1000;

  console.log(`Récupération des deals du ${new Date(fromMs).toISOString()} au ${new Date(toMs).toISOString()}...`);
  const deals = await getClosedDeals(fromMs, toMs);
  console.log(`\n${deals.length} deals de clôture trouvés.\n`);

  let netProfit = 0;
  for (const d of deals) {
    netProfit += d.netProfit;
    console.log(
      `${d.closedAt} | ${d.instrument} ${d.direction} vol=${d.volume} | gross=${d.grossProfit.toFixed(2)} swap=${d.swap.toFixed(2)} comm=${d.commission.toFixed(2)} net=${d.netProfit.toFixed(2)} | balanceAfter=${d.balanceAfter.toFixed(2)}`
    );
  }
  console.log(`\nNet profit total: ${netProfit.toFixed(2)} USD`);
  process.exit(0);
}

main().catch(err => {
  console.error('Erreur:', err);
  process.exit(1);
});
