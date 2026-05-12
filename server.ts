
import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { createClient } from '@supabase/supabase-js';
import crypto from "crypto";
import { calculateIndicators, analyzeMarket, INITIAL_ASSETS, DEFAULT_STRATEGY, STRATEGIES } from "./services/marketEngine.ts";
import { Signal, SignalStatus, SignalType, AssetType, TimeFrame } from "./types.ts";
import type { AgentLimits, AgentMode } from "./types.ts";
import { ctraderService } from "./services/ctraderService.ts";
import type { OrderResult } from "./services/ctraderService.ts";
import { agentController } from "./services/agentController.ts";

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
let activeStrategy = DEFAULT_STRATEGY;
let lastScanTime = 0;
let lastBatchTimeMs = 0;
const MAX_CURRENCY_EXPOSURE = 2;
const MAX_LOGS = 50;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Cache pour les données de marché
const marketCache = new Map<string, { data: any, expiry: number }>();
const CACHE_DURATION = 60 * 1000;

// --- HELPERS ---
async function sendTelegramMessage(text: string, replyMarkup?: any) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ Telegram not configured. Skipping message.");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      })
    });
    if (!response.ok) console.error("Telegram Error:", await response.text());
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

async function answerTelegramCallback(callbackQueryId: string, text: string, showAlert = false) {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      }),
    });
  } catch (error) {
    console.error("Failed to answer Telegram callback:", error);
  }
}

function findActiveSignalById(idOrPrefix: string): Signal | undefined {
  return activeSignals.find(s => s.id === idOrPrefix)
    ?? activeSignals.find(s => s.id.startsWith(idOrPrefix));
}

async function executeSignalById(idOrPrefix: string): Promise<OrderResult & { signal?: Signal }> {
  const signal = findActiveSignalById(idOrPrefix);
  if (!signal) return { error: 'Signal non trouvé' };
  if (signal.ctraderPositionId) return { error: 'Déjà exécuté', positionId: signal.ctraderPositionId, signal };

  if (process.env.CTRADER_LIVE !== 'true') {
    console.warn(`⛔ CTRADER_LIVE != 'true' — ordre bloqué pour ${signal.asset}. Passez CTRADER_LIVE=true pour activer le trading live.`);
    return { error: "Mode demo actif (CTRADER_LIVE != 'true'). Ordre non envoyé.", signal };
  }

  try {
    if (!ctraderService.isConnected()) {
      await ctraderService.init();
    }

    const accountInfo = await ctraderService.getAccountInfo();
    const result = await ctraderService.placeOrder(signal, accountInfo.balance, agentController.getPositionSizing());
    if (result.positionId) {
      signal.ctraderPositionId = result.positionId;
      if (supabase) await supabase.from('signals').update({ content: signal }).eq('id', signal.id);
    }
    return { ...result, signal };
  } catch (e: any) {
    return { error: e.message ?? String(e), signal };
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
    } catch (e) {
      console.error("Erreur chargement initial Supabase:", e);
    }
  } else {
    console.warn("📦 Supabase non configuré, démarrage avec état vide.");
  }

  // Init agent controller (charge mode + limites depuis Supabase)
  await agentController.init(supabase);

  // Init cTrader si mode != SIGNALS_ONLY
  if (agentController.getMode() !== 'SIGNALS_ONLY') {
    try {
      await ctraderService.init();
      console.log('✅ cTrader service initialisé');
    } catch (e: any) {
      console.error('❌ cTrader init échoué:', e.message, '— mode forcé SIGNALS_ONLY');
      await agentController.setMode('SIGNALS_ONLY');
    }
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
                if (existing.ctraderPositionId) {
                  await ctraderService.amendSL(existing.ctraderPositionId, existing.priceAtSignal);
                  console.log(`🛡️ SL breakeven envoyé à cTrader pour ${existing.asset}`);
                }
              }
            }

            // 2. Check Sortie (TP/SL)
            const target = existing.tradeSetup.takeProfit;
            const sl = existing.tradeSetup.stopLoss;
            const hitTP = isBuy ? currentPrice >= target : currentPrice <= target;
            const hitSL = isBuy ? currentPrice <= Math.max(sl, chandelier) : currentPrice >= Math.min(sl, chandelier);

            if (hitTP || hitSL) {
              const initialRisk = Math.abs(existing.priceAtSignal - (existing.tradeSetup.stopLoss || sl));
              const pnl = (isBuy ? (currentPrice - existing.priceAtSignal) : (existing.priceAtSignal - currentPrice)) / initialRisk;
              const status = pnl > 0.1 ? SignalStatus.WIN : SignalStatus.LOSS;
              
              const closedSignal = { ...existing, status, closePrice: currentPrice, closedAt: Date.now(), pnl: pnl - 0.05, isNew: false };
              
              // Persistance
              activeSignals = activeSignals.filter(s => s.id !== existing.id);
              tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);

              if (existing.ctraderPositionId) {
                const closeResult = await ctraderService.closePosition(existing.ctraderPositionId);
                if (closeResult.alreadyClosed) {
                  console.log(`ℹ️ Position ${existing.ctraderPositionId} déjà fermée par cTrader (SL/TP natif)`);
                }
              }

              if (supabase) {
                await supabase.from('signals').delete().eq('id', existing.id);
                await supabase.from('history').insert({ id: existing.id, asset: existing.asset, pnl: closedSignal.pnl, closed_at: new Date(closedSignal.closedAt).toISOString(), content: closedSignal });
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
            const { signal: result, diagnostic } = analyzeMarket(asset.symbol, data.price, indicators, activeStrategy);
            
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
                isBreakevenSet: false
              };

              const { isAllowed, reason } = checkCurrencyExposure(activeSignals, newSignal, MAX_CURRENCY_EXPOSURE);
              
              if (isAllowed) {
                activeSignals.push(newSignal);
                scanLogs = [{ id: crypto.randomUUID(), timestamp: Date.now(), asset: asset.symbol, status: 'SUCCESS', reason: diagnostic }, ...scanLogs].slice(0, MAX_LOGS);
                if (supabase) await supabase.from('signals').insert({ id: newSignal.id, asset: newSignal.asset, timeframe: '15m', content: newSignal });

                const decision = agentController.shouldExecute(newSignal, activeSignals);

                if (decision.execute) {
                  const accountInfo = await ctraderService.getAccountInfo();
                  const result = await ctraderService.placeOrder(newSignal, accountInfo.balance, agentController.getPositionSizing());
                  if (result.positionId) {
                    newSignal.ctraderPositionId = result.positionId;
                    if (supabase) await supabase.from('signals').update({ content: newSignal }).eq('id', newSignal.id);
                  }
                  await sendTelegramMessage(`
🚀 *SIGNAL EXÉCUTÉ* 🚀
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}
*Position ID:* ${result.positionId ?? 'N/A'}
                  `);
                } else if (decision.mode === 'SEMI_AUTO') {
                  await sendTelegramMessage(`
🔔 *SIGNAL EN ATTENTE DE VALIDATION* 🔔
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*Confiance:* ${newSignal.confidence}%

👉 Exécuter : /execute\\_${newSignal.id.substring(0, 8)}
                  `, {
                    inline_keyboard: [[
                      { text: '✅ Valider le trade', callback_data: `execute:${newSignal.id}` },
                      { text: '❌ Ignorer', callback_data: `ignore:${newSignal.id}` },
                    ]],
                  });
                } else {
                  await sendTelegramMessage(`
🚀 *NOUVEAU SIGNAL SNIPER V15* 🚀
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}
                  `);
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

    // Sync drawdown + positions fermées côté broker
    if (agentController.getMode() !== 'SIGNALS_ONLY' && ctraderService.isConnected()) {
      const accountInfo = await ctraderService.getAccountInfo();
      const emergencyTriggered = await agentController.checkDrawdown(accountInfo.balance);
      if (emergencyTriggered) {
        for (const sig of activeSignals) {
          if (sig.ctraderPositionId) await ctraderService.closePosition(sig.ctraderPositionId);
        }
        activeSignals = [];
        if (supabase) await supabase.from('signals').delete().neq('id', 'none');
        await sendTelegramMessage("🚨 *ARRÊT D'URGENCE* — Drawdown max atteint. Toutes positions fermées.");
      }

      // Réconcilier positions ouvertes vs activeSignals
      const openIds = new Set(await ctraderService.getOpenPositionIds());
      for (const sig of [...activeSignals]) {
        if (sig.ctraderPositionId && !openIds.has(sig.ctraderPositionId)) {
          console.log(`📡 Position ${sig.ctraderPositionId} fermée par cTrader — sync`);
          const currentPrice = marketData[sig.asset]?.price ?? sig.priceAtSignal;
          const isBuy = sig.type === SignalType.BUY;
          const initialRisk = Math.abs(sig.priceAtSignal - sig.tradeSetup.stopLoss);
          const pnl = (isBuy ? (currentPrice - sig.priceAtSignal) : (sig.priceAtSignal - currentPrice)) / (initialRisk || 1);
          const status = pnl > 0.1 ? SignalStatus.WIN : SignalStatus.LOSS;
          const closedSignal = { ...sig, status, closePrice: currentPrice, closedAt: Date.now(), pnl: pnl - 0.05, isNew: false };
          activeSignals = activeSignals.filter(s => s.id !== sig.id);
          tradeHistory = [closedSignal, ...tradeHistory].slice(0, 200);
          if (supabase) {
            await supabase.from('signals').delete().eq('id', sig.id);
            await supabase.from('history').insert({ id: sig.id, asset: sig.asset, pnl: closedSignal.pnl, closed_at: new Date(closedSignal.closedAt).toISOString(), content: closedSignal });
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, 5 * 60 * 1000)); // Scan toutes les 5 min
  }
}

// --- API SERVER ---
async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const isProduction = process.env.NODE_ENV === "production";

  app.use(express.json());

  app.use((req, res, next) => {
    console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  const apiRouter = express.Router();
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const secret = process.env.API_SECRET_TOKEN;
    const appPassword = process.env.VITE_APP_PASSWORD;
    if (!secret && !appPassword) {
      if (isProduction) {
        return res.status(503).json({ error: "API auth is not configured" });
      }
      return next();
    }

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth || (auth !== secret && auth !== appPassword)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };

  const sensitiveRateLimit = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }

    if (entry.count >= 10) {
      return res.status(429).json({ error: "Too many requests" });
    }

    entry.count += 1;
    next();
  };

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    }
  }, 60_000).unref();

  const toLegacyMode = (mode: AgentMode): 'signals' | 'semi-auto' | 'autonomous' => {
    if (mode === 'SEMI_AUTO') return 'semi-auto';
    if (mode === 'AUTONOMOUS') return 'autonomous';
    return 'signals';
  };

  const toAgentMode = (mode: unknown): AgentMode | null => {
    if (mode === 'signals' || mode === 'SIGNALS_ONLY') return 'SIGNALS_ONLY';
    if (mode === 'semi-auto' || mode === 'SEMI_AUTO') return 'SEMI_AUTO';
    if (mode === 'autonomous' || mode === 'AUTONOMOUS') return 'AUTONOMOUS';
    if (mode === 'EMERGENCY_STOP') return 'EMERGENCY_STOP';
    return null;
  };

  // Endpoints API
  apiRouter.get("/health", (req, res) => {
    console.log("GET /api/health");
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      services: {
        supabase: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
        telegram: Boolean(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
        gemini: Boolean(process.env.API_KEY && process.env.API_KEY !== 'votre_cle_gemini'),
        ctrader: Boolean(process.env.CTRADER_ACCESS_TOKEN && process.env.CTRADER_ACCOUNT_ID),
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
  apiRouter.get("/engine/status", (req, res) => {
    console.log("GET /api/engine/status");
    const limits = agentController.getLimits();
    res.json({
      isRunning: isEngineRunning,
      lastScanTime,
      lastBatchTimeMs,
      activeCount: activeSignals.length,
      activeStrategyId: activeStrategy.id,
      mutedAssets,
      agentMode: toLegacyMode(agentController.getMode()),
      riskLimits: {
        maxConcurrentTrades: limits.maxSimultaneousTrades,
        maxTotalRiskPercent: limits.maxRiskPercent,
        maxDrawdownPercent: limits.maxDrawdownPercent,
      },
    });
  });
  apiRouter.post("/engine/risk", requireAuth, async (req, res) => {
    const { maxConcurrentTrades, maxTotalRiskPercent, maxDrawdownPercent } = req.body;
    const nextLimits: Partial<AgentLimits> = {};
    if (maxConcurrentTrades !== undefined) nextLimits.maxSimultaneousTrades = maxConcurrentTrades;
    if (maxTotalRiskPercent !== undefined) nextLimits.maxRiskPercent = maxTotalRiskPercent;
    if (maxDrawdownPercent !== undefined) nextLimits.maxDrawdownPercent = maxDrawdownPercent;
    await agentController.setLimits(nextLimits);
    const limits = agentController.getLimits();
    res.json({
      success: true,
      riskLimits: {
        maxConcurrentTrades: limits.maxSimultaneousTrades,
        maxTotalRiskPercent: limits.maxRiskPercent,
        maxDrawdownPercent: limits.maxDrawdownPercent,
      },
    });
  });
  apiRouter.post("/engine/mode", sensitiveRateLimit, requireAuth, async (req, res) => {
    const mode = toAgentMode(req.body?.mode);
    if (!mode || mode === 'EMERGENCY_STOP') {
      return res.status(400).json({ error: "Mode invalide. Valeurs: signals, semi-auto, autonomous" });
    }
    if (mode !== 'SIGNALS_ONLY' && !ctraderService.isConnected()) {
      try { await ctraderService.init(); } catch (e: any) {
        return res.status(500).json({ error: `cTrader init échoué: ${e.message}` });
      }
    }
    await agentController.setMode(mode);
    res.json({ success: true, agentMode: toLegacyMode(mode), mode });
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
    res.json({ success: true, mutedAssets });
  });
  apiRouter.post("/engine/unmute", requireAuth, (req, res) => {
    const { symbol } = req.body;
    if (symbol) {
      delete mutedAssets[symbol];
    } else {
      mutedAssets = {};
    }
    res.json({ success: true, mutedAssets });
  });
  // --- AGENT CONTROLLER ENDPOINTS ---
  apiRouter.get("/agent/status", async (req, res) => {
    const accountInfo = ctraderService.isConnected()
      ? await ctraderService.getAccountInfo()
      : { balance: 0, equity: 0 };
    res.json({
      mode: agentController.getMode(),
      limits: agentController.getLimits(),
      connected: ctraderService.isConnected(),
      balance: accountInfo.balance,
      equity: accountInfo.equity,
      openPositions: activeSignals.filter(s => s.ctraderPositionId).length,
    });
  });

  apiRouter.post("/agent/mode", sensitiveRateLimit, requireAuth, async (req, res) => {
    const { mode } = req.body as { mode: AgentMode };
    const valid: AgentMode[] = ['SIGNALS_ONLY', 'SEMI_AUTO', 'AUTONOMOUS', 'EMERGENCY_STOP'];
    if (!valid.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });
    if (mode !== 'SIGNALS_ONLY' && !ctraderService.isConnected()) {
      try { await ctraderService.init(); } catch (e: any) {
        return res.status(500).json({ error: `cTrader init échoué: ${e.message}` });
      }
    }
    await agentController.setMode(mode);
    res.json({ success: true, mode });
  });

  apiRouter.post("/agent/limits", requireAuth, async (req, res) => {
    const { maxSimultaneousTrades, maxRiskPercent, maxDrawdownPercent, positionSizing } = req.body;
    await agentController.setLimits({ maxSimultaneousTrades, maxRiskPercent, maxDrawdownPercent, positionSizing });
    res.json({ success: true, limits: agentController.getLimits() });
  });

  apiRouter.post("/telegram/webhook", async (req, res) => {
    const update = req.body;
    const message = update.message;
    const callbackQuery = update.callback_query;
    const chatId = message?.chat?.id?.toString() ?? callbackQuery?.message?.chat?.id?.toString();

    if (TELEGRAM_CHAT_ID && chatId && chatId !== TELEGRAM_CHAT_ID.toString()) {
      return res.json({ ok: true, ignored: true });
    }

    try {
      if (callbackQuery?.data) {
        const [action, signalId] = callbackQuery.data.split(':');

        if (action === 'ignore') {
          await answerTelegramCallback(callbackQuery.id, 'Signal ignoré.');
          return res.json({ ok: true });
        }

        if (action === 'execute' && signalId) {
          await answerTelegramCallback(callbackQuery.id, 'Validation reçue, exécution en cours...');
          const result = await executeSignalById(signalId);
          if (result.positionId) {
            await sendTelegramMessage(`✅ *TRADE VALIDÉ ET EXÉCUTÉ*\n*Actif:* ${result.signal?.asset ?? signalId}\n*Position ID:* ${result.positionId}`);
          } else {
            await sendTelegramMessage(`❌ *VALIDATION ÉCHOUÉE*\n*Signal:* ${signalId.substring(0, 8)}\n*Erreur:* ${result.error ?? 'Erreur inconnue'}`);
          }
          return res.json({ ok: true, success: !result.error, ...result });
        }
      }

      const text = message?.text as string | undefined;
      const match = text?.match(/^\/execute[_\s-]?([a-zA-Z0-9-]{8,36})/);
      if (match?.[1]) {
        const result = await executeSignalById(match[1]);
        if (result.positionId) {
          await sendTelegramMessage(`✅ *TRADE VALIDÉ ET EXÉCUTÉ*\n*Actif:* ${result.signal?.asset ?? match[1]}\n*Position ID:* ${result.positionId}`);
        } else {
          await sendTelegramMessage(`❌ *VALIDATION ÉCHOUÉE*\n*Signal:* ${match[1]}\n*Erreur:* ${result.error ?? 'Erreur inconnue'}`);
        }
        return res.json({ ok: true, success: !result.error, ...result });
      }

      res.json({ ok: true });
    } catch (e: any) {
      console.error('Telegram webhook error:', e);
      await sendTelegramMessage(`❌ *VALIDATION ÉCHOUÉE*\n*Erreur:* ${e.message ?? e}`);
      res.json({ ok: true, error: e.message ?? String(e) });
    }
  });

  apiRouter.post("/agent/execute/:id", sensitiveRateLimit, requireAuth, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await executeSignalById(id);
    if (result.error === 'Signal non trouvé') return res.status(404).json({ error: result.error });
    if (result.error === 'Déjà exécuté') return res.status(400).json({ error: result.error, positionId: result.positionId });
    res.json({ success: !result.error, ...result });
  });

  apiRouter.post("/agent/emergency-stop", sensitiveRateLimit, requireAuth, async (req, res) => {
    await agentController.setMode('EMERGENCY_STOP');
    isEngineRunning = false;
    const results = await Promise.allSettled(
      activeSignals
        .filter(s => s.ctraderPositionId)
        .map(s => ctraderService.closePosition(s.ctraderPositionId!))
    );
    activeSignals = [];
    if (supabase) await supabase.from('signals').delete().neq('id', 'none');
    await sendTelegramMessage("🚨 *ARRÊT D'URGENCE ACTIVÉ* — Toutes positions fermées, moteur arrêté.");
    res.json({ success: true, closedCount: results.length });
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
  app.use("/api/*wildcard", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      root: __dirname,
      configFile: false,
      plugins: [react()],
      resolve: {
        alias: {
          "@": __dirname,
        },
      },
      define: {
        "process.env.VITE_SUPABASE_URL": JSON.stringify(process.env.VITE_SUPABASE_URL || ""),
        "process.env.VITE_SUPABASE_KEY": JSON.stringify(process.env.VITE_SUPABASE_KEY || ""),
        "process.env.VITE_APP_PASSWORD": JSON.stringify(process.env.VITE_APP_PASSWORD || ""),
        "process.env.VITE_API_URL": JSON.stringify(process.env.VITE_API_URL || ""),
      },
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*wildcard', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    runBackgroundMonitor().catch(console.error);
  });
}

startServer();
