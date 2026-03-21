
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

// Cache pour les données de marché
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

async function fetchYahooInternal(symbol: string, interval: string = '15m', range: string = '15d', retries: number = 3) {
  const cacheKey = `${symbol}_${interval}_${range}`;
  const cached = marketCache.get(cacheKey);
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

      marketCache.set(cacheKey, { data, expiry: Date.now() + CACHE_DURATION });
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

    for (const asset of INITIAL_ASSETS) {
      if (!asset.active) continue;

      // Check Cooldown
      const cooldownExpiry = mutedAssets[asset.symbol];
      if (cooldownExpiry && Date.now() < cooldownExpiry) continue;

      try {
        const data = await fetchYahooInternal(asset.symbol);
        const indicators = calculateIndicators(data.history, data.highs, data.lows, data.opens, data.volumes, activeStrategy, asset.symbol);
        
        if (indicators) {
          marketData[asset.symbol] = { ...data, lastIndicators: indicators };
          const existing = activeSignals.find(s => s.asset === asset.symbol);
          
          if (existing) {
            // --- SUIVI DU TRADE EXISTANT ---
            const currentPrice = data.price;
            const isBuy = existing.type === SignalType.BUY;
            const chandelier = indicators.chandelierExit;
            
            // 1. Check Breakeven
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

            // 2. Check Sortie (TP/SL)
            const target = existing.tradeSetup.takeProfit;
            const sl = existing.tradeSetup.stopLoss;
            const hitTP = isBuy ? currentPrice >= target : currentPrice <= target;
            const hitSL = isBuy ? currentPrice <= Math.max(sl, chandelier) : currentPrice >= Math.min(sl, chandelier);

            if (hitTP || hitSL) {
              const originalSL = existing.originalStopLoss ?? existing.tradeSetup.stopLoss;
              const initialRisk = Math.abs(existing.priceAtSignal - originalSL);
              if (initialRisk === 0) continue; // Sécurité anti-division par zéro
              const pnl = (isBuy ? (currentPrice - existing.priceAtSignal) : (existing.priceAtSignal - currentPrice)) / initialRisk;
              const status = pnl > 0.1 ? SignalStatus.WIN : SignalStatus.LOSS;
              
              const closedSignal = { ...existing, status, closePrice: currentPrice, closedAt: Date.now(), pnl: pnl - 0.05, isNew: false };
              
              // Persistance
              activeSignals = activeSignals.filter(s => s.id !== existing.id);
              tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);
              
              if (supabase) {
                await supabase.from('signals').delete().eq('id', existing.id);
                await supabase.from('history').insert({ id: existing.id, asset: existing.asset, pnl: closedSignal.pnl, content: closedSignal });
              }

              await sendTelegramMessage(`
🏁 *TRADE CLÔTURÉ* 🏁
*Actif:* ${asset.name}
*Résultat:* ${status === SignalStatus.WIN ? '✅ GAIN' : '❌ PERTE'}
*Profit:* ${closedSignal.pnl.toFixed(2)}R
*Prix de sortie:* ${currentPrice.toFixed(5)}
              `);
            }
          } else {
            // --- ANALYSE POUR NOUVEAU SIGNAL ---
            const econCtx = await isHighImpactEventSoon(asset.symbol, 60);
            const { signal: result, diagnostic } = analyzeMarket(asset.symbol, data.price, indicators, activeStrategy, econCtx);
            
            if (result) {
              const newSignal: Signal = {
                id: crypto.randomUUID(),
                asset: asset.symbol,
                assetType: asset.type,
                type: result.type,
                timestamp: Date.now(),
                timeFrame: TimeFrame.M15,
                priceAtSignal: data.price,
                trendStrength: result.strength,
                indicators: indicators,
                tradeSetup: result.tradeSetup,
                reasoning: result.reasoning,
                status: SignalStatus.OPEN,
                confidence: result.strength,
                winProbability: result.winProbability,
                scoreBreakdown: result.scoreBreakdown,
                estimatedDuration: result.estimatedDuration,
                isNew: true,
                isBreakevenSet: false,
                originalStopLoss: result.tradeSetup.stopLoss
              };

              const { isAllowed, reason } = checkCurrencyExposure(activeSignals, newSignal, MAX_CURRENCY_EXPOSURE);
              
              if (isAllowed) {
                activeSignals.push(newSignal);
                scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'SUCCESS', reason: diagnostic }, ...scanLogs].slice(0, MAX_LOGS);
                if (supabase) {
                  await supabase.from('signals').insert({ id: newSignal.id, asset: newSignal.asset, timeframe: '15m', content: newSignal });
                }
                
                const signalEmoji = newSignal.type === SignalType.BUY ? '🟢' : '🔴';
                const semiAuto = agentMode === 'semi-auto';
                await sendTelegramMessage(
                  `🚀 *NOUVEAU SIGNAL SNIPER V15* 🚀\n` +
                  `*Actif:* ${asset.name}\n` +
                  `*Action:* ${signalEmoji} ${newSignal.type === SignalType.BUY ? 'ACHAT' : 'VENTE'}\n` +
                  `*Entrée:* ${data.price.toFixed(5)}\n` +
                  `*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}\n` +
                  `*Confiance:* ${newSignal.confidence}%`,
                  semiAuto ? [[
                    { text: '✅ Valider', callback_data: `execute:${newSignal.id}` },
                    { text: '❌ Ignorer', callback_data: `ignore:${newSignal.id}` },
                  ]] : undefined
                );

                // --- MODE AUTONOME ---
                if (agentMode === 'autonomous') {
                  if (newSignal.confidence >= AUTONOMOUS_MIN_CONFIDENCE) {
                    const { allowed: riskOk, reason: riskReason } = await checkRiskLimits();
                    if (!riskOk) {
                      scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol,
                        status: 'RISK_BLOCKED',
                        reason: `🛡️ Risque bloqué — ${riskReason}`
                      }, ...scanLogs].slice(0, MAX_LOGS);
                    } else {
                    const orderResult = await placeOrder(newSignal);
                    if (orderResult.success && orderResult.tradeId) {
                      brokerTradeIds.set(newSignal.id, orderResult.tradeId);
                      scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol,
                        status: 'AUTO_EXECUTED',
                        reason: `🤖 Autonome — Confiance: ${newSignal.confidence}% ≥ ${AUTONOMOUS_MIN_CONFIDENCE}% — cTrader #${orderResult.tradeId} (${orderResult.units} units)`
                      }, ...scanLogs].slice(0, MAX_LOGS);
                      await sendTelegramMessage(
                        `🤖 *EXÉCUTION AUTONOME* 🤖\n` +
                        `*Actif:* ${asset.name}\n` +
                        `*Action:* ${signalEmoji} ${newSignal.type === SignalType.BUY ? 'ACHAT' : 'VENTE'}\n` +
                        `*Entrée:* ${data.price.toFixed(5)}\n` +
                        `*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}\n` +
                        `*Confiance:* ${newSignal.confidence}% | *cTrader:* \`${orderResult.tradeId}\``
                      );
                    } else {
                      scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol,
                        status: 'AUTO_EXEC_FAILED',
                        reason: `🤖 Autonome échoué — ${orderResult.error}`
                      }, ...scanLogs].slice(0, MAX_LOGS);
                      await sendTelegramMessage(`⚠️ *Exécution autonome échouée* — ${asset.name}\nErreur: ${orderResult.error}`);
                    }
                    } // end riskOk
                  } else {
                    scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol,
                      status: 'AUTO_SKIPPED',
                      reason: `🤖 Seuil non atteint — Confiance ${newSignal.confidence}% < ${AUTONOMOUS_MIN_CONFIDENCE}%`
                    }, ...scanLogs].slice(0, MAX_LOGS);
                  }
                }
              } else {
                scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'REJECTED', reason: reason }, ...scanLogs].slice(0, MAX_LOGS);
              }
            } else if (Math.random() > 0.7) {
              scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'REJECTED', reason: diagnostic }, ...scanLogs].slice(0, MAX_LOGS);
            }
          }
        }
        await new Promise(r => setTimeout(r, 1000)); // Rate limiting
      } catch (error: any) {
        console.error(`Error monitoring ${asset.symbol}:`, error.message);
        scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'ERROR', reason: error.message }, ...scanLogs].slice(0, MAX_LOGS);
      }
    }

    lastScanTime = Date.now();
    lastBatchTimeMs = Date.now() - startTime;
    await new Promise(r => setTimeout(r, 5 * 60 * 1000)); // Scan toutes les 5 min
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
  const PORT = 3000;

  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  const apiRouter = express.Router();

  // --- MIDDLEWARE AUTH ---
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const secret = process.env.API_SECRET_TOKEN;
    if (!secret) return next(); // Pas de token configuré = pas de protection (dev)
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  // Endpoints API
  apiRouter.get("/health", (req, res) => {
    console.log("GET /api/health");
    res.json({ status: "ok", time: new Date().toISOString() });
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
    res.json(status);
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
  apiRouter.post("/engine/mode", requireAuth, async (req, res) => {
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

  apiRouter.post("/signals/:id/analyze", async (req, res) => {
    const signal = activeSignals.find(s => s.id === req.params.id);
    if (!signal) return res.status(404).json({ error: "Signal non trouvé" });
    const events = await getUpcomingHighImpactEvents(24);
    const result = await generateSignalExplanation(signal, events);
    res.json(result); // { text, sources, macroScore }
  });

  apiRouter.post("/signals/:id/execute", requireAuth, async (req, res) => {
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
  apiRouter.post("/agent/emergency-stop", requireAuth, async (req, res) => {
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
