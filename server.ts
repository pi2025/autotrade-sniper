
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { createClient } from '@supabase/supabase-js';
import crypto from "crypto";
import { calculateIndicators, analyzeMarket, INITIAL_ASSETS, DEFAULT_STRATEGY, STRATEGIES } from "./services/marketEngine.ts";
import { isHighImpactEventSoon } from "./services/economicCalendarService.ts";
import { testConnection, placeOrder, getAccountBalance, closeOrder, getOpenTrades } from "./services/ctraderService.ts";
import { generateSignalExplanation } from "./services/geminiService.ts";
import { getUpcomingHighImpactEvents } from "./services/economicCalendarService.ts";
import { Signal, SignalStatus, SignalType, AssetType, TimeFrame } from "./types.ts";
import { runScreener } from "./services/agents/screenerAgent.ts";
import { runTechnicalAnalysis } from "./services/agents/technicalAgent.ts";
import { runMacroAnalysis } from "./services/agents/macroAgent.ts";
import { runRiskCheck } from "./services/agents/riskAgent.ts";
import { runDecisionAgent } from "./services/agents/decisionAgent.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Supabase Config
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_KEY;

let supabase: any = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("✅ Supabase client initialized");
  } catch (e) {
    console.error("❌ Failed to initialize Supabase client:", e);
  }
} else {
  console.error("⚠️ SUPABASE_URL or SUPABASE_ANON_KEY missing. Supabase features will be disabled.");
}

// --- ÉTAT DU SERVEUR ---
let isEngineRunning = true;
let activeSignals: Signal[] = [];
let tradeHistory: Signal[] = [];
let scanLogs: any[] = [];
let marketData: Record<string, any> = {};
let mutedAssets: Record<string, number> = {};
type AgentMode = 'signals' | 'semi-auto' | 'autonomous';
let agentMode: AgentMode = 'signals'; // défaut : détection uniquement, pas d'exécution
let activeStrategy = DEFAULT_STRATEGY;
let lastScanTime = 0;
let lastBatchTimeMs = 0;
// Limites de risque global (chargées depuis app_config, valeurs par défaut sécurisées)
let riskLimits = {
  maxConcurrentTrades: 3,   // max trades ouverts simultanément
  maxTotalRiskPercent:  5,  // max % du capital engagé en même temps
  maxDrawdownPercent:  15,  // suspension si drawdown > X% depuis capital initial
  initialCapital:       0,  // chargé depuis le broker au 1er démarrage
};
// signalId → brokerTradeId (stockage en mémoire, non persisté)
const brokerTradeIds = new Map<string, string>();
const MAX_CURRENCY_EXPOSURE = 2;
const MAX_LOGS = 50;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
// Seuil de confiance minimum pour l'exécution autonome (configurable via env)
const AUTONOMOUS_MIN_CONFIDENCE = parseInt(process.env.AUTONOMOUS_MIN_CONFIDENCE || '75', 10);

// Cache pour les données de marché (plafonné à 50 entrées pour éviter les fuites mémoire)
const MAX_CACHE_SIZE = 50;
const marketCache = new Map<string, { data: any, expiry: number }>();
const CACHE_DURATION = 60 * 1000;

// --- HELPERS ---
interface TelegramButton { text: string; url?: string; callback_data?: string; }

async function sendTelegramMessage(
  text: string,
  buttons?: TelegramButton[][]  // tableau de rangées de boutons (optionnel)
) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram not configured. Skipping message.");
    return;
  }
  const body: any = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };
  if (buttons?.length) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!response.ok) console.error("Telegram Error:", await response.text());
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

const getCurrenciesFromAsset = (asset: string, assetType: AssetType): { base: string; quote: string } | null => {
  const specialMappings: Record<string, { base: string; quote: string }> = {
    'GC=F': { base: 'XAU', quote: 'USD' },
    'SI=F': { base: 'XAG', quote: 'USD' },
    'CL=F': { base: 'WTI', quote: 'USD' },
    '^GSPC': { base: 'SPX', quote: 'USD' },
    '^IXIC': { base: 'NDX', quote: 'USD' },
    '^FCHI': { base: 'CAC', quote: 'EUR' },
  };
  if (specialMappings[asset]) return specialMappings[asset];
  if (assetType === AssetType.FOREX) {
    const clean = asset.replace('=X', '');
    if (clean.length === 6) return { base: clean.substring(0, 3), quote: clean.substring(3, 6) };
  }
  return null;
};

const checkCurrencyExposure = (openSignals: Signal[], newSignal: Signal, threshold: number): { isAllowed: boolean; reason: string } => {
  const exposure: Record<string, number> = {};
  const allSignals = [...openSignals, newSignal];
  for (const s of allSignals) {
    const currencies = getCurrenciesFromAsset(s.asset, s.assetType);
    if (currencies) {
      const { base, quote } = currencies;
      const weight = s.type === SignalType.BUY ? 1 : -1;
      exposure[base] = (exposure[base] || 0) + weight;
      exposure[quote] = (exposure[quote] || 0) - weight;
    }
  }
  const newSignalCurrencies = getCurrenciesFromAsset(newSignal.asset, newSignal.assetType);
  if (newSignalCurrencies) {
    const { base, quote } = newSignalCurrencies;
    if (Math.abs(exposure[base] || 0) > threshold) return { isAllowed: false, reason: `Exposition ${base} > ${threshold}R` };
    if (Math.abs(exposure[quote] || 0) > threshold) return { isAllowed: false, reason: `Exposition ${quote} > ${threshold}R` };
  }
  return { isAllowed: true, reason: '' };
};

// Cache durations par timeframe
const CACHE_TTL: Record<string, number> = { '1h': 10 * 60 * 1000, '15m': 60 * 1000 };

interface MultiTFData {
  h1: { price: number; history: number[]; highs: number[]; lows: number[]; opens: number[]; volumes: number[] };
  m15: { price: number; history: number[]; highs: number[]; lows: number[]; opens: number[]; volumes: number[] };
  symbol: string;
  price: number;
}

async function fetchMultiTimeframe(symbol: string): Promise<MultiTFData> {
  const [h1, m15] = await Promise.all([
    fetchYahooInternal(symbol, '1h', '60d'),
    fetchYahooInternal(symbol, '15m', '15d'),
  ]);
  return { h1, m15, symbol, price: m15.price };
}

async function fetchYahooInternal(symbol: string, interval: string = '15m', range: string = '15d', retries: number = 3) {
  const cacheKey = `${symbol}_${interval}_${range}`;
  const cached = marketCache.get(cacheKey);
  const ttl = CACHE_TTL[interval] || CACHE_DURATION;
  if (cached && cached.expiry > Date.now()) return cached.data;

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&events=history&includeAdjustedClose=true`;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
      });

      if (response.status === 429) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`⚠️ Rate limited (429) pour ${symbol}. Attente de ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) throw new Error(`Yahoo API error ${response.status}`);
      const json: any = await response.json();
      const result = json.chart?.result?.[0];
      if (!result) throw new Error("No result in Yahoo JSON");

      const timestamps = result.timestamp;
      const quote = result.indicators.quote[0];
      const validIndices = timestamps.map((_: any, i: number) => i).filter((i: number) => quote.close[i] != null);

      const data = {
        symbol,
        price: quote.close[validIndices[validIndices.length - 1]],
        history: validIndices.map((i: number) => quote.close[i]),
        highs: validIndices.map((i: number) => quote.high[i]),
        lows: validIndices.map((i: number) => quote.low[i]),
        opens: validIndices.map((i: number) => quote.open[i]),
        volumes: quote.volume ? validIndices.map((i: number) => quote.volume[i]) : new Array(validIndices.length).fill(0)
      };

      // Éviction LRU si le cache dépasse la taille max
      if (marketCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = marketCache.keys().next().value;
        if (oldestKey) marketCache.delete(oldestKey);
      }
      marketCache.set(cacheKey, { data, expiry: Date.now() + ttl });
      return data;
    } catch (error: any) {
      if (attempt === retries - 1) throw error;
      const wait = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// --- CIRCUIT-BREAKER D'URGENCE ---
async function emergencyStop(triggeredBy: string): Promise<string> {
  // 1. Basculer en mode signals immédiatement
  agentMode = 'signals';
  isEngineRunning = false;
  if (supabase) supabase.from('app_config').upsert({ key: 'agentMode', value: 'signals' });

  // 2. Fermer tous les trades ouverts sur le broker
  const openTrades = await getOpenTrades();
  let closed = 0, failed = 0;
  for (const trade of openTrades) {
    const result = await closeOrder(trade.tradeId);
    result.success ? closed++ : failed++;
  }

  // 3. Vider brokerTradeIds en mémoire
  brokerTradeIds.clear();

  const summary =
    `🚨 *EMERGENCY STOP* — Déclenché par: ${triggeredBy}\n` +
    `Trades fermés: ${closed} ✅ | Échecs: ${failed} ❌\n` +
    `Moteur arrêté. Mode: SIGNALS uniquement.`;

  await sendTelegramMessage(summary);
  console.log(`🚨 Emergency Stop: ${closed} trades fermés, ${failed} échecs`);
  return summary;
}

// --- GESTIONNAIRE DE RISQUE GLOBAL ---
async function checkRiskLimits(): Promise<{ allowed: boolean; reason: string }> {
  // 1. Nombre de trades ouverts (vérification locale, pas de réseau)
  if (activeSignals.length >= riskLimits.maxConcurrentTrades) {
    return { allowed: false, reason: `Limite trades simultanés atteinte (${activeSignals.length}/${riskLimits.maxConcurrentTrades})` };
  }

  // 2. Risque total engagé + 3. Drawdown (un seul appel broker)
  const acc = await getAccountBalance();
  if (acc) {
    const riskPerTrade = parseFloat(process.env.CTRADER_RISK_PERCENT || '1');
    const totalRiskPercent = activeSignals.length * riskPerTrade;
    if (totalRiskPercent >= riskLimits.maxTotalRiskPercent) {
      return { allowed: false, reason: `Risque total max atteint (${totalRiskPercent}% ≥ ${riskLimits.maxTotalRiskPercent}%)` };
    }

    if (riskLimits.initialCapital > 0) {
      const drawdownPct = ((riskLimits.initialCapital - acc.balance) / riskLimits.initialCapital) * 100;
      if (drawdownPct >= riskLimits.maxDrawdownPercent) {
        if (agentMode !== 'signals') {
          agentMode = 'signals';
          if (supabase) supabase.from('app_config').upsert({ key: 'agentMode', value: 'signals' });
          await sendTelegramMessage(
            `🚨 *DRAWDOWN CRITIQUE* — Agent suspendu automatiquement\n` +
            `Drawdown: ${drawdownPct.toFixed(1)}% ≥ ${riskLimits.maxDrawdownPercent}%\n` +
            `Mode basculé sur SIGNALS uniquement.`
          );
        }
        return { allowed: false, reason: `Drawdown critique: ${drawdownPct.toFixed(1)}% — Agent suspendu` };
      }
    }
  }

  return { allowed: true, reason: '' };
}

// --- MOTEUR DE TRADING ---
async function runBackgroundMonitor() {
  console.log("🚀 Moteur Sniper V15 Unifié Démarré (24/7)");
  
  // Chargement initial depuis Supabase
  if (supabase) {
    try {
      const { data: sigs } = await supabase.from('signals').select('*');
      if (sigs) activeSignals = sigs.map(s => s.content);
      const { data: hist } = await supabase.from('history').select('*').order('closed_at', { ascending: false }).limit(100);
      if (hist) tradeHistory = hist.map(h => h.content);
      console.log(`📦 Chargement: ${activeSignals.length} actifs, ${tradeHistory.length} historiques`);

      const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'mutedAssets').single();
      if (cfg?.value) {
        mutedAssets = cfg.value;
        console.log(`🔇 mutedAssets restaurés: ${Object.keys(mutedAssets).length} actif(s)`);
      }

      const { data: modeCfg } = await supabase.from('app_config').select('value').eq('key', 'agentMode').single();
      if (modeCfg?.value) {
        agentMode = modeCfg.value as AgentMode;
        console.log(`🤖 agentMode restauré: ${agentMode}`);
      }

      const { data: riskCfg } = await supabase.from('app_config').select('value').eq('key', 'riskLimits').single();
      if (riskCfg?.value) {
        riskLimits = { ...riskLimits, ...riskCfg.value };
        console.log(`🛡️ riskLimits restaurés:`, riskLimits);
      }

      // Capital initial : récupéré une fois depuis le broker, puis persisté
      if (riskLimits.initialCapital === 0) {
        const acc = await getAccountBalance();
        if (acc) {
          riskLimits.initialCapital = acc.balance;
          supabase.from('app_config').upsert({ key: 'riskLimits', value: riskLimits });
          console.log(`💰 Capital initial enregistré: ${acc.balance} ${acc.currency}`);
        }
      }
    } catch (e) {
      console.error("Erreur chargement initial Supabase:", e);
    }
  } else {
    console.warn("📦 Supabase non configuré, démarrage avec état vide.");
  }

  while (true) {
    if (!isEngineRunning) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const startTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] Scan en cours...`);

    // === ÉTAPE 1 : SUIVI DES TRADES EXISTANTS (sur données H1 pour trailing stable) ===
    for (const existing of [...activeSignals]) {
      try {
        // Utiliser H1 pour le trailing stop (plus stable que M15)
        const h1Data = await fetchYahooInternal(existing.asset, '1h', '60d');
        const m15Data = await fetchYahooInternal(existing.asset);
        const asset = INITIAL_ASSETS.find(a => a.symbol === existing.asset);
        if (!m15Data || !asset) continue;

        const h1Indicators = calculateIndicators(h1Data.history, h1Data.highs, h1Data.lows, h1Data.opens, h1Data.volumes, activeStrategy, existing.asset);
        const m15Indicators = calculateIndicators(m15Data.history, m15Data.highs, m15Data.lows, m15Data.opens, m15Data.volumes, activeStrategy, existing.asset);
        if (m15Indicators) {
          marketData[existing.asset] = { ...m15Data, lastIndicators: m15Indicators };
        }

        const currentPrice = m15Data.price;
        const isBuy = existing.type === SignalType.BUY;

        // Trailing stop via Chandelier Exit H1 (pas M15 — trop serré)
        if (h1Indicators) {
          const chandelier = h1Indicators.chandelierExit;
          const currentSL = existing.tradeSetup.stopLoss;
          if (isBuy && chandelier > currentSL) {
            existing.tradeSetup.stopLoss = chandelier;
          } else if (!isBuy && chandelier < currentSL) {
            existing.tradeSetup.stopLoss = chandelier;
          }
        }

        // Check Breakeven
        if (!existing.isBreakevenSet && existing.tradeSetup.breakevenPrice) {
          const reached = isBuy ? currentPrice >= existing.tradeSetup.breakevenPrice : currentPrice <= existing.tradeSetup.breakevenPrice;
          if (reached) {
            existing.tradeSetup.stopLoss = existing.priceAtSignal;
            existing.isBreakevenSet = true;
            if (supabase) {
              await supabase.from('signals').update({ content: existing }).eq('id', existing.id);
            }
            await sendTelegramMessage(`🛡️ *BREAKEVEN ACTIVÉ* pour ${asset.name}\nLe Stop Loss a été déplacé au prix d'entrée (${existing.priceAtSignal.toFixed(5)}).`);
          }
        }

        // Check Sortie (TP/SL)
        const target = existing.tradeSetup.takeProfit;
        const sl = existing.tradeSetup.stopLoss;
        const hitTP = isBuy ? currentPrice >= target : currentPrice <= target;
        const hitSL = isBuy ? currentPrice <= sl : currentPrice >= sl;

        if (hitTP || hitSL) {
          const originalSL = existing.originalStopLoss ?? existing.tradeSetup.stopLoss;
          const initialRisk = Math.abs(existing.priceAtSignal - originalSL);
          if (initialRisk === 0) continue;
          const pnl = (isBuy ? (currentPrice - existing.priceAtSignal) : (existing.priceAtSignal - currentPrice)) / initialRisk;
          const status = pnl > 0.1 ? SignalStatus.WIN : SignalStatus.LOSS;

          const closedSignal = { ...existing, status, closePrice: currentPrice, closedAt: Date.now(), pnl: pnl - 0.05, isNew: false };
          activeSignals = activeSignals.filter(s => s.id !== existing.id);
          tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);

          if (supabase) {
            await supabase.from('signals').delete().eq('id', existing.id);
            await supabase.from('history').insert({ id: existing.id, asset: existing.asset, pnl: closedSignal.pnl, content: closedSignal });
          }

          await sendTelegramMessage(`🏁 *TRADE CLÔTURÉ* 🏁\n*Actif:* ${asset.name}\n*Résultat:* ${status === SignalStatus.WIN ? '✅ GAIN' : '❌ PERTE'}\n*Profit:* ${closedSignal.pnl.toFixed(2)}R\n*Prix de sortie:* ${currentPrice.toFixed(5)}`);
        }
      } catch (error: any) {
        console.error(`Error tracking ${existing.asset}:`, error.message);
      }
    }

    // === ÉTAPE 2 : PIPELINE MULTI-AGENT IA POUR NOUVEAUX SIGNAUX ===
    try {
      // 2a. Récupérer les données multi-timeframe pour tous les actifs
      const multiTFData = new Map<string, { h1: any; m15: any; price: number }>();
      for (const asset of INITIAL_ASSETS) {
        if (!asset.active) continue;
        if (activeSignals.find(s => s.asset === asset.symbol)) continue; // Skip si trade déjà ouvert
        try {
          const mtf = await fetchMultiTimeframe(asset.symbol);
          multiTFData.set(asset.symbol, mtf);
          marketData[asset.symbol] = { ...mtf.m15, lastIndicators: null };
          await new Promise(r => setTimeout(r, 500));
        } catch (e: any) {
          console.error(`MTF fetch failed for ${asset.symbol}:`, e.message);
        }
      }

      // 2b. Agent 1 — Screener
      const { candidates, rejected } = runScreener(INITIAL_ASSETS, multiTFData, activeStrategy, mutedAssets);
      console.log(`📊 Screener: ${candidates.length} candidats, ${rejected.length} rejetés`);

      for (const rej of rejected) {
        if (Math.random() > 0.7) {
          scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: rej.symbol, status: 'REJECTED', reason: `Screener: ${rej.reason}` }, ...scanLogs].slice(0, MAX_LOGS);
        }
      }

      // 2c. Agents 2-5 pour chaque candidat (top 10 max pour économiser les appels IA)
      const topCandidates = candidates.slice(0, 10);

      for (const candidate of topCandidates) {
        // Vérifier la limite de trades AVANT de lancer les agents IA
        if (activeSignals.length >= riskLimits.maxConcurrentTrades) {
          console.log(`⚠️ Max trades atteint (${activeSignals.length}/${riskLimits.maxConcurrentTrades}) — arrêt du pipeline`);
          scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'RISK_BLOCKED', reason: `Limite trades simultanés atteinte (${activeSignals.length}/${riskLimits.maxConcurrentTrades})` }, ...scanLogs].slice(0, MAX_LOGS);
          break;
        }

        try {
          // Agent 2 — Analyste Technique IA
          const technical = await runTechnicalAnalysis(candidate);
          if (technical.direction === 'NEUTRAL' || technical.score < 40) {
            scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'REJECTED', reason: `Tech IA: score ${technical.score}, dir ${technical.direction} — ${technical.reasoning}` }, ...scanLogs].slice(0, MAX_LOGS);
            continue;
          }

          // Agent 3 — Analyste Macro IA
          const macro = await runMacroAnalysis(candidate, technical);

          // Agent 4 — Risk Manager
          const risk = runRiskCheck(candidate, technical, macro, activeSignals);

          // Agent 5 — Décideur Senior IA
          const decision = await runDecisionAgent({ candidate, technical, macro, risk });

          console.log(`🤖 Pipeline ${candidate.asset.symbol}: Tech=${technical.score} Macro=${macro.score} Risk=${risk.status} → ${decision.action} (${decision.confidence}%)`);

          if (decision.action === 'SKIP') {
            scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'REJECTED', reason: `Pipeline IA: ${decision.aiVerdict}` }, ...scanLogs].slice(0, MAX_LOGS);
            continue;
          }

          // === SIGNAL VALIDÉ PAR LE COMITÉ IA ===
          const asset = candidate.asset;
          const h1Ind = candidate.h1Indicators;
          const riskR = Math.abs(candidate.price - decision.slPrice);
          const rewardR = Math.abs(decision.tpPrice - candidate.price);

          const newSignal: Signal = {
            id: crypto.randomUUID(),
            asset: asset.symbol,
            assetType: asset.type,
            type: decision.direction === 'BUY' ? SignalType.BUY : SignalType.SELL,
            timestamp: Date.now(),
            timeFrame: TimeFrame.H1,
            priceAtSignal: candidate.price,
            trendStrength: decision.confidence,
            indicators: h1Ind,
            tradeSetup: {
              entryPrice: candidate.price,
              stopLoss: decision.slPrice,
              takeProfit: decision.tpPrice,
              positionSizeUnit: 1,
              riskAmount: decision.riskPercent,
              riskRewardRatio: riskR > 0 ? rewardR / riskR : 0,
              breakevenPrice: decision.direction === 'BUY'
                ? candidate.price + h1Ind.atr * 1.5
                : candidate.price - h1Ind.atr * 1.5,
            },
            reasoning: decision.reasoning,
            aiExplanation: `🤖 Comité IA:\n• Tech: ${technical.reasoning} (${technical.score}/100)\n• Macro: ${macro.reasoning} (${macro.score}/100)\n• Risk: ${risk.reasons.join(', ')}\n• Verdict: ${decision.aiVerdict}`,
            status: SignalStatus.OPEN,
            confidence: decision.confidence,
            winProbability: decision.confidence,
            scoreBreakdown: [
              { label: 'Screener', score: candidate.screenScore, type: candidate.screenScore > 60 ? 'POSITIVE' : 'NEUTRAL' as const },
              { label: 'Technique IA', score: technical.score, type: technical.score > 60 ? 'POSITIVE' : 'NEUTRAL' as const },
              { label: 'Macro IA', score: macro.score, type: macro.score > 60 ? 'POSITIVE' : macro.score < 40 ? 'NEGATIVE' : 'NEUTRAL' as const },
              { label: 'Risk Manager', score: risk.status === 'APPROVED' ? 80 : 40, type: risk.status === 'APPROVED' ? 'POSITIVE' : 'NEGATIVE' as const },
            ],
            estimatedDuration: '4-12h',
            isNew: true,
            isBreakevenSet: false,
            originalStopLoss: decision.slPrice,
          };

          const { isAllowed, reason } = checkCurrencyExposure(activeSignals, newSignal, MAX_CURRENCY_EXPOSURE);

          if (isAllowed) {
            activeSignals.push(newSignal);
            scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'SUCCESS', reason: `Pipeline IA: ${decision.aiVerdict}` }, ...scanLogs].slice(0, MAX_LOGS);

            if (supabase) {
              await supabase.from('signals').insert({ id: newSignal.id, asset: newSignal.asset, timeframe: '1h', content: newSignal });
            }

            const signalEmoji = newSignal.type === SignalType.BUY ? '🟢' : '🔴';
            const semiAuto = agentMode === 'semi-auto';
            await sendTelegramMessage(
              `🚀 *SIGNAL SNIPER V15 — COMITÉ IA* 🚀\n` +
              `*Actif:* ${asset.name}\n` +
              `*Action:* ${signalEmoji} ${newSignal.type === SignalType.BUY ? 'ACHAT' : 'VENTE'}\n` +
              `*Entrée:* ${candidate.price.toFixed(5)}\n` +
              `*TP:* ${decision.tpPrice.toFixed(5)} | *SL:* ${decision.slPrice.toFixed(5)}\n` +
              `*Confiance:* ${decision.confidence}% | *R:R:* ${newSignal.tradeSetup.riskRewardRatio.toFixed(1)}\n` +
              `*Type:* ${technical.entryType}\n` +
              `*Macro:* ${macro.alertLevel} ${macro.bias}`,
              semiAuto ? [[
                { text: '✅ Valider', callback_data: `execute:${newSignal.id}` },
                { text: '❌ Ignorer', callback_data: `ignore:${newSignal.id}` },
              ]] : undefined
            );

            // --- MODE AUTONOME ---
            if (agentMode === 'autonomous') {
              if (decision.confidence >= AUTONOMOUS_MIN_CONFIDENCE) {
                const { allowed: riskOk, reason: riskReason } = await checkRiskLimits();
                if (!riskOk) {
                  scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'RISK_BLOCKED', reason: `🛡️ Risque bloqué — ${riskReason}` }, ...scanLogs].slice(0, MAX_LOGS);
                } else {
                  const orderResult = await placeOrder(newSignal);
                  if (orderResult.success && orderResult.tradeId) {
                    brokerTradeIds.set(newSignal.id, orderResult.tradeId);
                    scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'AUTO_EXECUTED', reason: `🤖 Autonome IA — Confiance: ${decision.confidence}% — cTrader #${orderResult.tradeId}` }, ...scanLogs].slice(0, MAX_LOGS);
                    await sendTelegramMessage(`🤖 *EXÉCUTION AUTONOME IA* 🤖\n*Actif:* ${asset.name}\n*Confiance:* ${decision.confidence}% | *cTrader:* \`${orderResult.tradeId}\``);
                  } else {
                    scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'AUTO_EXEC_FAILED', reason: `🤖 Autonome échoué — ${orderResult.error}` }, ...scanLogs].slice(0, MAX_LOGS);
                    await sendTelegramMessage(`⚠️ *Exécution autonome échouée* — ${asset.name}\nErreur: ${orderResult.error}`);
                  }
                }
              } else {
                scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'AUTO_SKIPPED', reason: `🤖 Seuil non atteint — Confiance ${decision.confidence}% < ${AUTONOMOUS_MIN_CONFIDENCE}%` }, ...scanLogs].slice(0, MAX_LOGS);
              }
            }
          } else {
            scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'REJECTED', reason: reason }, ...scanLogs].slice(0, MAX_LOGS);
          }

        } catch (agentError: any) {
          console.error(`Pipeline error for ${candidate.asset.symbol}:`, agentError.message);
          scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: candidate.asset.symbol, status: 'ERROR', reason: `Pipeline IA: ${agentError.message}` }, ...scanLogs].slice(0, MAX_LOGS);
        }
      }
    } catch (pipelineError: any) {
      console.error(`Pipeline global error:`, pipelineError.message);
    }

    lastScanTime = Date.now();
    lastBatchTimeMs = Date.now() - startTime;
    await new Promise(r => setTimeout(r, 5 * 60 * 1000)); // Scan toutes les 5 min — détection rapide des breakouts
  }
}

// --- API SERVER ---
// --- RAPPORT QUOTIDIEN ---
async function sendDailyReport() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // Trades clôturés aujourd'hui
  const todayTrades = tradeHistory.filter(t => t.closedAt && t.closedAt >= startOfDay);
  const wins   = todayTrades.filter(t => t.pnl && t.pnl > 0).length;
  const losses = todayTrades.filter(t => t.pnl && t.pnl <= 0).length;
  const totalR = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  // Solde actuel vs capital initial
  const acc = await getAccountBalance();
  const balanceNow = acc?.balance ?? 0;
  const currency   = acc?.currency ?? 'USD';
  const pnlUsd     = riskLimits.initialCapital > 0 ? balanceNow - riskLimits.initialCapital : 0;
  const drawdownPct = riskLimits.initialCapital > 0
    ? ((riskLimits.initialCapital - balanceNow) / riskLimits.initialCapital) * 100
    : 0;

  // Prochain événement économique majeur
  const upcoming = await getUpcomingHighImpactEvents(24);
  const nextEvent = upcoming[0];
  const nextEventStr = nextEvent
    ? `${nextEvent.currency} — ${nextEvent.title} (dans ${nextEvent.minutesUntil}min)`
    : 'Aucun événement majeur dans les 24h';

  await sendTelegramMessage(
    `📊 *RAPPORT QUOTIDIEN — ${now.toLocaleDateString('fr-FR')}*\n\n` +
    `*Trades du jour:* ${todayTrades.length} (${wins} ✅ / ${losses} ❌)\n` +
    `*PnL du jour:* ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R\n` +
    `*PnL USD:* ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} ${currency}\n\n` +
    `*Capital actuel:* ${balanceNow.toFixed(2)} ${currency}\n` +
    `*Capital initial:* ${riskLimits.initialCapital.toFixed(2)} ${currency}\n` +
    `*Drawdown:* ${drawdownPct > 0 ? drawdownPct.toFixed(1) + '%' : '0%'}\n\n` +
    `*Mode agent:* ${agentMode.toUpperCase()}\n` +
    `*Prochain événement:* ${nextEventStr}`
  );
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());

  // CORS pour le frontend déployé sur Netlify (ou autre domaine)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  app.use((req, res, next) => {
    console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  const apiRouter = express.Router();

  // --- RATE LIMITER (in-memory, par IP) ---
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const rateLimit = (maxRequests: number, windowMs: number) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = rateLimitMap.get(ip);
      if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
        return next();
      }
      if (entry.count >= maxRequests) {
        return res.status(429).json({ error: "Too many requests. Réessayez plus tard." });
      }
      entry.count++;
      next();
    };
  // Nettoyage périodique des entrées expirées
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 60_000);

  // Rate limit sur les endpoints sensibles : 10 req/min
  const sensitiveRateLimit = rateLimit(10, 60_000);

  // --- MIDDLEWARE AUTH ---
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const secret = process.env.API_SECRET_TOKEN;
    const appPassword = process.env.VITE_APP_PASSWORD;
    if (!secret && !appPassword) return next();
    const auth = req.headers.authorization?.replace('Bearer ', '');
    // Accepte le token serveur OU le mot de passe app (pour les appels depuis l'UI)
    if (!auth || (auth !== secret && auth !== appPassword)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  // Endpoints API
  apiRouter.get("/health", (req, res) => {
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      services: {
        supabase: !!process.env.VITE_SUPABASE_URL,
        telegram: !!process.env.TELEGRAM_BOT_TOKEN,
        gemini: !!process.env.GROQ_API_KEY,
        ctrader: !!process.env.CTRADER_ACCESS_TOKEN,
      },
    });
  });
  apiRouter.get("/signals", (req, res) => {
    console.log("GET /api/signals");
    res.json(activeSignals);
  });
  apiRouter.get("/history", (req, res) => {
    console.log("GET /api/history");
    res.json(tradeHistory);
  });
  apiRouter.get("/scanner", (req, res) => {
    console.log("GET /api/scanner");
    res.json({
      scanLogs,
      marketData
    });
  });
  apiRouter.get("/broker/status", async (req, res) => {
    const status = await testConnection();
    const openTrades = await getOpenTrades();
    res.json({
      ...status,
      initialCapital: riskLimits.initialCapital,
      openTrades: openTrades.map(t => ({ tradeId: t.tradeId, symbol: t.symbol, direction: t.direction, units: t.units, pnl: t.pnl })),
      openTradesCount: openTrades.length,
      drawdownPercent: status.balance && riskLimits.initialCapital > 0
        ? ((riskLimits.initialCapital - status.balance) / riskLimits.initialCapital * 100).toFixed(2)
        : null,
    });
  });
  apiRouter.get("/engine/status", (req, res) => {
    console.log("GET /api/engine/status");
    res.json({
      isRunning: isEngineRunning,
      lastScanTime,
      lastBatchTimeMs,
      activeCount: activeSignals.length,
      activeStrategyId: activeStrategy.id,
      mutedAssets,
      agentMode,
      riskLimits,
    });
  });
  apiRouter.post("/engine/risk", requireAuth, async (req, res) => {
    const { maxConcurrentTrades, maxTotalRiskPercent, maxDrawdownPercent } = req.body;
    if (maxConcurrentTrades !== undefined) riskLimits.maxConcurrentTrades = maxConcurrentTrades;
    if (maxTotalRiskPercent !== undefined) riskLimits.maxTotalRiskPercent = maxTotalRiskPercent;
    if (maxDrawdownPercent !== undefined) riskLimits.maxDrawdownPercent = maxDrawdownPercent;
    if (supabase) await supabase.from('app_config').upsert({ key: 'riskLimits', value: riskLimits });
    res.json({ success: true, riskLimits });
  });
  apiRouter.post("/engine/mode", sensitiveRateLimit, requireAuth, async (req, res) => {
    const { mode } = req.body;
    const valid: AgentMode[] = ['signals', 'semi-auto', 'autonomous'];
    if (!valid.includes(mode)) {
      return res.status(400).json({ error: `Mode invalide. Valeurs: ${valid.join(', ')}` });
    }
    agentMode = mode;
    if (supabase) {
      await supabase.from('app_config').upsert({ key: 'agentMode', value: mode });
    }
    console.log(`🤖 agentMode changé: ${agentMode}`);
    res.json({ success: true, agentMode });
  });
  apiRouter.post("/engine/toggle", requireAuth, (req, res) => {
    isEngineRunning = !isEngineRunning;
    res.json({ isRunning: isEngineRunning });
  });
  apiRouter.post("/engine/strategy", requireAuth, (req, res) => {
    const { strategyId } = req.body;
    const strategy = STRATEGIES.find(s => s.id === strategyId);
    if (strategy) {
      activeStrategy = strategy;
      res.json({ success: true, strategyId: activeStrategy.id });
    } else {
      res.status(400).json({ error: "Stratégie invalide" });
    }
  });
  apiRouter.post("/engine/mute", requireAuth, (req, res) => {
    const { symbol, durationMs } = req.body;
    mutedAssets[symbol] = Date.now() + (durationMs || COOLDOWN_MS);
    if (supabase) {
      supabase.from('app_config').upsert({ key: 'mutedAssets', value: mutedAssets });
    }
    res.json({ success: true, mutedAssets });
  });
  apiRouter.post("/engine/unmute", requireAuth, (req, res) => {
    const { symbol } = req.body;
    if (symbol) {
      delete mutedAssets[symbol];
    } else {
      mutedAssets = {};
    }
    if (supabase) {
      supabase.from('app_config').upsert({ key: 'mutedAssets', value: mutedAssets });
    }
    res.json({ success: true, mutedAssets });
  });
  apiRouter.delete("/signals/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    const signal = activeSignals.find(s => s.id === id);
    if (signal) {
      activeSignals = activeSignals.filter(s => s.id !== id);
      mutedAssets[signal.asset] = Date.now() + COOLDOWN_MS;
      if (supabase) {
        await supabase.from('signals').delete().eq('id', id);
      }
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Signal non trouvé" });
    }
  });

  apiRouter.delete("/signals/all/purge", requireAuth, async (req, res) => {
    const count = activeSignals.length;
    if (supabase) {
      for (const s of activeSignals) {
        await supabase.from('signals').delete().eq('id', s.id);
      }
    }
    activeSignals = [];
    console.log(`🗑️ Purge: ${count} signaux supprimés`);
    res.json({ success: true, purged: count });
  });

  apiRouter.post("/signals/:id/analyze", async (req, res) => {
    const signal = activeSignals.find(s => s.id === req.params.id);
    if (!signal) return res.status(404).json({ error: "Signal non trouvé" });
    const events = await getUpcomingHighImpactEvents(24);
    const result = await generateSignalExplanation(signal, events);
    res.json(result); // { text, sources, macroScore }
  });

  apiRouter.post("/signals/:id/execute", sensitiveRateLimit, requireAuth, async (req, res) => {
    const { id } = req.params;
    const signal = activeSignals.find(s => s.id === id);
    if (!signal) return res.status(404).json({ error: "Signal non trouvé" });
    if (brokerTradeIds.has(id)) return res.status(409).json({ error: "Signal déjà exécuté sur cTrader" });

    const result = await placeOrder(signal);
    if (result.success && result.tradeId) {
      brokerTradeIds.set(id, result.tradeId);
      console.log(`✅ Signal ${id} exécuté sur cTrader — tradeId: ${result.tradeId}`);
      return res.json({ success: true, tradeId: result.tradeId, units: result.units });
    }
    return res.status(500).json({ success: false, error: result.error });
  });

  apiRouter.post("/telegram/webhook", async (req, res) => {
    // Telegram attend toujours un 200 rapide, même en cas d'erreur interne
    res.sendStatus(200);

    const update = req.body;
    const query = update?.callback_query;
    if (!query) return; // message ordinaire, on ignore

    const callbackId = query.id;
    const data: string = query.data ?? '';

    // Commande texte /stop via bouton ou message
    if (data === '/stop') {
      await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackId }) }
      ).catch(() => {});
      await emergencyStop(`Telegram @${query.from?.username ?? 'user'}`);
      return;
    }

    const [action, signalId] = data.split(':');

    // Acquittement immédiat du bouton (efface le spinner côté Telegram)
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId }) }
    ).catch(() => {});

    if (action === 'execute') {
      const signal = activeSignals.find(s => s.id === signalId);
      if (!signal) {
        await sendTelegramMessage(`⚠️ Signal \`${signalId.slice(0, 8)}\` introuvable ou déjà clôturé.`);
        return;
      }
      if (brokerTradeIds.has(signalId)) {
        await sendTelegramMessage(`⚠️ Signal \`${signal.asset}\` déjà exécuté sur cTrader.`);
        return;
      }
      const result = await placeOrder(signal);
      if (result.success && result.tradeId) {
        brokerTradeIds.set(signalId, result.tradeId);
        await sendTelegramMessage(
          `✅ *ORDRE EXÉCUTÉ*\n` +
          `*Actif:* ${signal.asset}\n` +
          `*cTrader Trade ID:* \`${result.tradeId}\`\n` +
          `*Taille:* ${result.units} units`
        );
      } else {
        await sendTelegramMessage(`❌ *Échec exécution* ${signal.asset}\nErreur: ${result.error}`);
      }
    } else if (action === 'ignore') {
      const signal = activeSignals.find(s => s.id === signalId);
      if (signal) {
        activeSignals = activeSignals.filter(s => s.id !== signalId);
        mutedAssets[signal.asset] = Date.now() + COOLDOWN_MS;
        if (supabase) {
          await supabase.from('signals').delete().eq('id', signalId);
          supabase.from('app_config').upsert({ key: 'mutedAssets', value: mutedAssets });
        }
        await sendTelegramMessage(`🔇 Signal *${signal.asset}* ignoré — cooldown 30 min activé.`);
      }
    }
  });

  // Emergency stop
  apiRouter.post("/agent/emergency-stop", sensitiveRateLimit, requireAuth, async (req, res) => {
    const summary = await emergencyStop('API HTTP');
    res.json({ success: true, summary });
  });

  // Proxy Yahoo
  apiRouter.get("/market/yahoo", async (req, res) => {
    const { symbol, interval, range } = req.query;
    try {
      const data = await fetchYahooInternal(symbol as string, interval as string, range as string);
      res.json({ chart: { result: [{ timestamp: [Date.now()], indicators: { quote: [{ close: [data.price], high: [data.price], low: [data.price], open: [data.price] }] } }] } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Diagnostic Groq IA — test complet avec un vrai prompt technique
  apiRouter.get("/diag/groq-test", async (req, res) => {
    if (!process.env.GROQ_API_KEY) return res.json({ ok: false, error: 'GROQ_API_KEY not set' });
    try {
      const Groq = (await import('groq-sdk')).default;
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const start = Date.now();
      const r = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Réponds UNIQUEMENT en JSON valide.' },
          { role: 'user', content: 'Analyse technique EURUSD: ADX 30, RSI 55, prix au-dessus EMA20. Réponds en JSON: {"score": <0-100>, "direction": "<BUY|SELL|NEUTRAL>", "reasoning": "<1 phrase>"}' }
        ],
        temperature: 0.3,
        max_tokens: 200,
      });
      const text = r.choices[0]?.message?.content || '';
      const elapsed = Date.now() - start;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      res.json({
        ok: true,
        elapsed_ms: elapsed,
        raw: text.substring(0, 300),
        parsed: jsonMatch ? JSON.parse(jsonMatch[0]) : null,
        model: r.model,
        usage: r.usage,
      });
    } catch (e: any) {
      res.json({ ok: false, error: e.message, status: e.status, errorBody: e.error });
    }
  });

  // Diagnostic Groq IA simple
  apiRouter.get("/diag/ai", async (req, res) => {
    const hasKey = !!process.env.GROQ_API_KEY;
    const keyLen = (process.env.GROQ_API_KEY || '').length;
    if (!hasKey) return res.json({ ok: false, error: 'GROQ_API_KEY not set', keyLen });
    try {
      const Groq = (await import('groq-sdk')).default;
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const r = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Réponds juste "OK"' }],
      });
      res.json({ ok: true, response: r.choices[0]?.message?.content?.substring(0, 100), keyLen, model: 'llama-3.3-70b-versatile' });
    } catch (e: any) {
      res.json({ ok: false, error: e.message, keyLen });
    }
  });

  // Appliquer le router API
  app.use("/api", apiRouter);

  // Gestionnaire 404 pour les routes /api/* (pour éviter le fallback HTML)
  app.use("/api/*path", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*path', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    runBackgroundMonitor().catch(console.error);

    // Self-ping keepalive pour Render Free tier (toutes les 13 min)
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(async () => {
      try {
        const res = await fetch(`${RENDER_URL}/api/engine/status`);
        console.log(`🏓 Keepalive ping: ${res.status}`);
      } catch (e: any) {
        console.warn(`🏓 Keepalive failed: ${e.message}`);
      }
    }, 13 * 60 * 1000);

    // Rapport quotidien à 22h00 heure locale
    (async function scheduleDailyReport() {
      while (true) {
        const now = new Date();
        const next22h = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0, 0, 0);
        if (next22h <= now) next22h.setDate(next22h.getDate() + 1);
        const msUntil = next22h.getTime() - now.getTime();
        await new Promise(r => setTimeout(r, msUntil));
        await sendDailyReport().catch(console.error);
      }
    })();
  });
}

startServer();
