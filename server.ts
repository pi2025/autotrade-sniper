
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { createClient } from '@supabase/supabase-js';
import crypto from "crypto";
import { calculateIndicators, analyzeMarket, INITIAL_ASSETS, DEFAULT_STRATEGY, STRATEGIES } from "./services/marketEngine.ts";
import { testConnection } from "./services/oandaService.ts";
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
async function sendTelegramMessage(text: string) {
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
        parse_mode: 'Markdown'
      })
    });
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
              const initialRisk = Math.abs(existing.priceAtSignal - (existing.tradeSetup.stopLoss || sl));
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
                if (supabase) {
                  await supabase.from('signals').insert({ id: newSignal.id, asset: newSignal.asset, timeframe: '15m', content: newSignal });
                }
                
                await sendTelegramMessage(`
🚀 *NOUVEAU SIGNAL SNIPER V15* 🚀
*Actif:* ${asset.name}
*Action:* ${newSignal.type === SignalType.BUY ? '🟢 ACHAT' : '🔴 VENTE'}
*Entrée:* ${data.price.toFixed(5)}
*TP:* ${newSignal.tradeSetup.takeProfit.toFixed(5)} | *SL:* ${newSignal.tradeSetup.stopLoss.toFixed(5)}
                `);
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
      mutedAssets
    });
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
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    runBackgroundMonitor().catch(console.error);
  });
}

startServer();
