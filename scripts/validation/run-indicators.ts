#!/usr/bin/env npx tsx
/**
 * scripts/validation/run-indicators.ts — Étape B2
 *
 * Diagnostic des filtres : sur les données H1 (~2 ans), quelle proportion
 * de barres chaque filtre de la cascade rejette ?
 *
 * Sortie clé : si un seul filtre rejette 95% des barres à lui seul,
 * c'est lui le goulot — pas "7 filtres solides".
 *
 * Usage : npx tsx scripts/validation/run-indicators.ts
 * Pré-requis : avoir lancé fetch-historical.ts (B1)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateIndicators, analyzeMarket, DEFAULT_STRATEGY } from '../../services/marketEngine.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const LOOKBACK   = 1200; // fenêtre fixe pour les indicateurs (>> EMA200=200)
const STEP       = 4;    // 1 évaluation toutes les 4 barres H1 = toutes les 4h

interface OHLCVBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface HistoricalData { symbol: string; interval: string; bars: OHLCVBar[]; }

// Ordre exact des rejets dans analyzeMarket (lignes 301-315 de marketEngine.ts)
const FILTER_LABELS = [
  'MTF alignement (EMA50/EMA200)',
  'Choppiness < 55',
  'ADX fort (seuil stratégie)',
  'ADX croissant (momentum)',
  'Fan EMA (widening)',
  'RSI hors zone [28-72]',
  'Cassure Donchian / Fan entry',
];

function classifyRejection(diagnostic: string): number {
  if (diagnostic.includes('Désalignement') || diagnostic.includes('Temporel')) return 0;
  if (diagnostic.includes('haché') || diagnostic.includes('Choppiness')) return 1;
  if (diagnostic.includes('ADX') && (diagnostic.includes('<') || diagnostic.includes('seuil'))) return 2;
  if (diagnostic.includes('Momentum') || diagnostic.includes('baisse')) return 3;
  if (diagnostic.includes('Fan') || diagnostic.includes('essouffle') || diagnostic.includes('narr')) return 4;
  if (diagnostic.includes('RSI')) return 5;
  return 6;
}

function analyzeSymbol(symbol: string, bars: OHLCVBar[]) {
  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const opens   = bars.map(b => b.open);
  const volumes = bars.map(b => b.volume);

  const rejects = new Array(FILTER_LABELS.length).fill(0);
  let evaluated = 0, signals = 0, longSig = 0, shortSig = 0;
  const sampleSignals: { date: string; type: string; price: number; winProb: number }[] = [];

  for (let i = LOOKBACK; i < bars.length; i += STEP) {
    // Fenêtre fixe : toujours LOOKBACK barres → O(LOOKBACK) par appel, pas O(i)
    const win = { end: i + 1, start: i + 1 - LOOKBACK };
    const ind = calculateIndicators(
      closes.slice(win.start, win.end),
      highs.slice(win.start, win.end),
      lows.slice(win.start, win.end),
      opens.slice(win.start, win.end),
      volumes.slice(win.start, win.end),
      DEFAULT_STRATEGY,
      symbol,
    );
    if (!ind) continue;
    evaluated++;

    const { signal, diagnostic } = analyzeMarket(symbol, closes[i], ind, DEFAULT_STRATEGY);

    if (signal) {
      signals++;
      if (signal.type === 'BUY') longSig++; else shortSig++;
      if (sampleSignals.length < 5) {
        sampleSignals.push({
          date: new Date(bars[i].ts).toISOString().slice(0, 16),
          type: signal.type,
          price: closes[i],
          winProb: signal.winProbability,
        });
      }
    } else {
      rejects[classifyRejection(diagnostic)]++;
    }
  }

  return { symbol, evaluated, signals, longSig, shortSig, rejects, sampleSignals };
}

async function main() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('_1h.json'))
    .sort();

  if (files.length === 0) {
    console.error('❌ Aucun fichier *_1h.json dans scripts/validation/data/ — lancer B1 d\'abord.');
    process.exit(1);
  }

  console.log(`\n📊 Étape B2 — Diagnostic des filtres (H1, ${files.length} actifs)`);
  console.log(`   Stratégie : ${DEFAULT_STRATEGY.name} | Fenêtre indicateurs : ${LOOKBACK} barres | Step : ${STEP}\n`);

  const allResults: ReturnType<typeof analyzeSymbol>[] = [];

  for (const file of files) {
    const data: HistoricalData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    process.stdout.write(`  ▶ ${data.symbol.padEnd(12)} ... `);
    const result = analyzeSymbol(data.symbol, data.bars);
    const signalRate = result.evaluated > 0 ? (result.signals / result.evaluated * 100).toFixed(1) : '0.0';
    console.log(`${result.evaluated} barres → ${result.signals} signaux (${signalRate}%)`);
    allResults.push(result);
  }

  // --- Tableau agrégé des rejets ---
  const totalEval    = allResults.reduce((s, r) => s + r.evaluated, 0);
  const totalSignals = allResults.reduce((s, r) => s + r.signals, 0);
  const totalLong    = allResults.reduce((s, r) => s + r.longSig, 0);
  const totalShort   = allResults.reduce((s, r) => s + r.shortSig, 0);
  const totalRejects = allResults.reduce((s, r) => s + r.evaluated - r.signals, 0);

  console.log('\n\n═══════════════════════ Taux de rejet par filtre ═══════════════════════');
  FILTER_LABELS.forEach((label, i) => {
    const n   = allResults.reduce((s, r) => s + r.rejects[i], 0);
    const pct = totalRejects > 0 ? (n / totalRejects * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${label.padEnd(32)} ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  });

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  const overallRate = totalEval > 0 ? (totalSignals / totalEval * 100).toFixed(2) : '0.00';
  console.log(`  Barres évaluées (9 actifs)  : ${totalEval.toLocaleString()}`);
  console.log(`  Signaux générés             : ${totalSignals} (${overallRate}% des barres)`);
  console.log(`  Long : ${totalLong}  |  Short : ${totalShort}`);

  // --- Verdict B2 ---
  console.log('\n  ─── Verdict ───────────────────────────────────────────────────');
  if (totalSignals === 0) {
    console.error('  ❌ 0 signaux — la cascade 7 filtres ne génère rien sur 2 ans de H1.');
    console.error('     → Réviser les seuils AVANT de lancer B3.');
  } else if (totalSignals < 15) {
    console.warn(`  ⚠️  ${totalSignals} signaux — critère "trop sélectif" : walk-forward non concluant.`);
    console.warn('     → Réviser les filtres les plus restrictifs (voir tableau ci-dessus).');
  } else if (totalSignals < 30) {
    console.warn(`  ⚠️  ${totalSignals} signaux — marginal (seuil : 30). Interpréter B3 avec précaution.`);
  } else {
    console.log(`  ✅ ${totalSignals} signaux — suffisant pour le walk-forward.`);
  }

  // Top rejector
  const aggRejects = FILTER_LABELS.map((label, i) => ({
    label,
    n: allResults.reduce((s, r) => s + r.rejects[i], 0),
  })).sort((a, b) => b.n - a.n);
  console.log(`\n  Filtre le plus restrictif : "${aggRejects[0].label}"`);
  console.log(`  (responsable de ${totalRejects > 0 ? (aggRejects[0].n / totalRejects * 100).toFixed(0) : 0}% des rejets)`);

  // --- Sauvegarde ---
  const out = {
    analyzedAt: Date.now(),
    strategy: DEFAULT_STRATEGY.name,
    lookback: LOOKBACK,
    step: STEP,
    totalEvaluated: totalEval,
    totalSignals,
    totalLong,
    totalShort,
    filterAggregated: FILTER_LABELS.map((label, i) => ({
      label,
      rejectCount: allResults.reduce((s, r) => s + r.rejects[i], 0),
      rejectPct: totalRejects > 0 ? parseFloat((allResults.reduce((s,r) => s + r.rejects[i], 0) / totalRejects * 100).toFixed(1)) : 0,
    })),
    perSymbol: allResults,
  };
  const outPath = path.join(DATA_DIR, '_b2_filter_analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`\n→ Résultats sauvegardés : ${path.basename(outPath)}`);
  console.log('→ Montrer ce tableau au CEO avant B3 (walk-forward).\n');
}

main().catch(e => { console.error(e); process.exit(1); });
