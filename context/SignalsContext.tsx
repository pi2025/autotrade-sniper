
import React, { createContext, useContext, useEffect, useReducer, useRef } from 'react';
import { AssetConfig, MarketData, Signal, TimeFrame, AssetType, StrategyParams, SignalStatus, SignalType, EmailConfig, TechnicalIndicators } from '../types';
import { calculateIndicators, analyzeMarket, INITIAL_ASSETS, DEFAULT_STRATEGY, STRATEGIES } from '../services/marketEngine';
import { fetchYahooData } from '../services/yahooService';
import { fetchBinanceData } from '../services/binanceService';
import { apiUrl } from '../services/api';
import { supabase, isConfigured as isSupabaseConfigured } from '../services/supabaseClient';

const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

interface ScanLog {
  id: string;
  timestamp: number;
  asset: string;
  status: 'SUCCESS' | 'REJECTED' | 'ERROR';
  reason: string;
}

interface MarketDataEntry extends MarketData {
  lastIndicators?: TechnicalIndicators;
  error?: boolean;
}

const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  serviceId: '',
  templateId: '',
  publicKey: '',
  targetEmail: ''
};

interface SignalsState {
  assets: AssetConfig[];
  marketData: Record<string, MarketDataEntry>; 
  signals: Signal[];       
  history: Signal[];       
  mutedAssets: Record<string, number>; 
  isEngineRunning: boolean;
  latestNotification: Signal | null;
  isLoading: boolean;
  activeStrategy: StrategyParams;
  emailConfig: EmailConfig;
  scanProgress: number; 
  lastScanTime: number;
  scanLogs: ScanLog[];
  performance?: {
    lastBatchTimeMs: number;
  };
}

const initialState: SignalsState = {
  assets: INITIAL_ASSETS,
  marketData: {},
  signals: [],
  history: [],
  mutedAssets: {},
  isEngineRunning: false,
  latestNotification: null,
  isLoading: true,
  activeStrategy: DEFAULT_STRATEGY,
  emailConfig: DEFAULT_EMAIL_CONFIG,
  scanProgress: 0,
  lastScanTime: 0,
  scanLogs: [],
  performance: { lastBatchTimeMs: 0 }
};

type Action =
  | { type: 'REFRESH_MARKET_DATA'; payload: { symbol: string; data: MarketDataEntry } }
  | { type: 'SET_MARKET_ERROR'; payload: string }
  | { type: 'ADD_SIGNAL'; payload: Signal }
  | { type: 'UPDATE_SIGNAL_STATUS'; payload: { id: string; tradeSetup: any; isBreakevenSet?: boolean } }
  | { type: 'DELETE_SIGNAL'; payload: { id: string, asset: string } }
  | { type: 'CLOSE_SIGNAL'; payload: { id: string; status: SignalStatus; closePrice: number; closedAt: number; pnl: number } }
  | { type: 'TOGGLE_ASSET'; payload: string }
  | { type: 'SET_ENGINE'; payload: boolean }
  | { type: 'UPDATE_SIGNAL_AI'; payload: { id: string; text: string } }
  | { type: 'CLEAR_NOTIFICATION' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ACTIVE_STRATEGY'; payload: StrategyParams }
  | { type: 'UPDATE_EMAIL_CONFIG'; payload: EmailConfig }
  | { type: 'LOAD_HISTORY'; payload: Signal[] }
  | { type: 'LOAD_ACTIVE_SIGNALS'; payload: Signal[] }
  | { type: 'LOAD_MUTED'; payload: Record<string, number> }
  | { type: 'CLEAR_MUTED' }
  | { type: 'SET_SCAN_PROGRESS'; payload: number }
  | { type: 'SET_LAST_SCAN_TIME'; payload: number }
  | { type: 'ADD_SCAN_LOG'; payload: ScanLog }
  | { type: 'SET_SCAN_LOGS'; payload: ScanLog[] }
  | { type: 'UPDATE_PERFORMANCE'; payload: number }
  | { type: 'RESET_DEFAULTS' };

const MAX_CURRENCY_EXPOSURE = 2; // Maximum 2R net exposure per currency

const getCurrenciesFromAsset = (asset: string, assetType: AssetType): { base: string; quote: string } | null => {
  const specialMappings: Record<string, { base: string; quote: string }> = {
    'GC=F': { base: 'XAU', quote: 'USD' },
    'SI=F': { base: 'XAG', quote: 'USD' },
    'CL=F': { base: 'WTI', quote: 'USD' },
    '^GSPC': { base: 'SPX', quote: 'USD' },
    '^IXIC': { base: 'NDX', quote: 'USD' },
    '^FCHI': { base: 'CAC', quote: 'EUR' },
  };
  if (specialMappings[asset]) {
    return specialMappings[asset];
  }

  if (assetType === AssetType.FOREX) {
    const clean = asset.replace('=X', '');
    if (clean.length === 6) {
      return { base: clean.substring(0, 3), quote: clean.substring(3, 6) };
    }
  }

  if (assetType === AssetType.CRYPTO) {
    const parts = asset.split('-');
    if (parts.length === 2) {
      return { base: parts[0], quote: parts[1] };
    }
  }

  return null;
};

const checkCurrencyExposure = (
  openSignals: Signal[],
  newSignal: Signal,
  threshold: number
): { isAllowed: boolean; reason: string } => {
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
    if (Math.abs(exposure[base]) > threshold) {
      return { isAllowed: false, reason: `Rejet: Exposition sur ${base} > ${threshold}R` };
    }
    if (Math.abs(exposure[quote]) > threshold) {
      return { isAllowed: false, reason: `Rejet: Exposition sur ${quote} > ${threshold}R` };
    }
  }

  return { isAllowed: true, reason: '' };
};

const signalsReducer = (state: SignalsState, action: Action): SignalsState => {
  switch (action.type) {
    case 'REFRESH_MARKET_DATA':
      return { ...state, marketData: { ...state.marketData, [action.payload.symbol]: action.payload.data } };
    case 'SET_MARKET_ERROR':
      return { ...state, marketData: { ...state.marketData, [action.payload]: { ...state.marketData[action.payload], error: true, symbol: action.payload } as MarketDataEntry } };
    case 'ADD_SIGNAL':
      const cooldown = state.mutedAssets[action.payload.asset];
      if (cooldown && Date.now() < cooldown) return state; 
      if (state.signals.some(s => s.asset === action.payload.asset)) return state;
      return { ...state, signals: [action.payload, ...state.signals], latestNotification: action.payload };
    case 'UPDATE_SIGNAL_STATUS':
      return { 
        ...state, 
        signals: state.signals.map(s => s.id === action.payload.id ? { ...s, tradeSetup: action.payload.tradeSetup, isBreakevenSet: action.payload.isBreakevenSet ?? s.isBreakevenSet } : s) 
      };
    case 'DELETE_SIGNAL':
      return { 
        ...state, 
        signals: state.signals.filter(s => s.id !== action.payload.id),
        mutedAssets: { 
          ...state.mutedAssets, 
          [action.payload.asset]: Date.now() + (30 * 60 * 1000) 
        }
      };
    case 'CLOSE_SIGNAL':
      const sToClose = state.signals.find(s => s.id === action.payload.id);
      if (!sToClose) return state;
      return { 
        ...state, 
        signals: state.signals.filter(s => s.id !== action.payload.id), 
        history: [{ ...sToClose, ...action.payload, isNew: false } as Signal, ...state.history] 
      };
    case 'SET_ENGINE': return { ...state, isEngineRunning: action.payload };
    case 'SET_LOADING': return { ...state, isLoading: action.payload };
    case 'LOAD_HISTORY': return { ...state, history: action.payload || [] };
    case 'LOAD_ACTIVE_SIGNALS': return { ...state, signals: action.payload || [] };
    case 'LOAD_MUTED': return { ...state, mutedAssets: action.payload || {} };
    case 'CLEAR_MUTED': return { ...state, mutedAssets: {} };
    case 'UPDATE_EMAIL_CONFIG': return { ...state, emailConfig: action.payload };
    case 'SET_SCAN_PROGRESS': return { ...state, scanProgress: action.payload };
    case 'SET_LAST_SCAN_TIME': return { ...state, lastScanTime: action.payload };
    case 'ADD_SCAN_LOG': 
      return { ...state, scanLogs: [action.payload, ...state.scanLogs].slice(0, 50) };
    case 'SET_SCAN_LOGS':
      return { ...state, scanLogs: action.payload };
    case 'UPDATE_PERFORMANCE':
      return { ...state, performance: { lastBatchTimeMs: action.payload } };
    case 'TOGGLE_ASSET': 
      return { ...state, assets: state.assets.map(a => a.symbol === action.payload ? { ...a, active: !a.active } : a) };
    case 'SET_ACTIVE_STRATEGY': return { ...state, activeStrategy: action.payload }; 
    case 'UPDATE_SIGNAL_AI':
      return { ...state, signals: state.signals.map(s => s.id === action.payload.id ? { ...s, aiExplanation: action.payload.text } : s) };
    case 'CLEAR_NOTIFICATION': return { ...state, latestNotification: null };
    case 'RESET_DEFAULTS': return { ...state, assets: INITIAL_ASSETS };
    default: return state;
  }
};

const SignalsContext = createContext<any>(null);

export const SignalsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(signalsReducer, initialState);
  
  const strategyRef = useRef(state.activeStrategy);
  const activeAssetsRef = useRef(state.assets);
  const currentSignalsRef = useRef(state.signals);
  const mutedAssetsRef = useRef(state.mutedAssets);

  useEffect(() => { 
    strategyRef.current = state.activeStrategy;
    activeAssetsRef.current = state.assets;
    currentSignalsRef.current = state.signals;
    mutedAssetsRef.current = state.mutedAssets;
  }, [state.activeStrategy, state.assets, state.signals, state.mutedAssets]);

  useEffect(() => {
    const initApp = async () => {
      const localMuted = localStorage.getItem('v15_muted_obj');
      if (localMuted) dispatch({ type: 'LOAD_MUTED', payload: JSON.parse(localMuted) });

      const localEmail = localStorage.getItem('v15_email_config');
      if (localEmail) dispatch({ type: 'UPDATE_EMAIL_CONFIG', payload: JSON.parse(localEmail) });

      if (!isSupabaseConfigured) {
        const localSigs = localStorage.getItem('v15_signals');
        if (localSigs) dispatch({ type: 'LOAD_ACTIVE_SIGNALS', payload: JSON.parse(localSigs) });
        const localHisto = localStorage.getItem('v15_history');
        if (localHisto) dispatch({ type: 'LOAD_HISTORY', payload: JSON.parse(localHisto) });
        dispatch({ type: 'SET_LOADING', payload: false });
        return;
      }

      try {
        const { data: cloudSigs } = await supabase.from('signals').select('*');
        if (cloudSigs) dispatch({ type: 'LOAD_ACTIVE_SIGNALS', payload: cloudSigs.map(s => s.content) });
        
        const { data: cloudHisto } = await supabase.from('history').select('*').order('closed_at', { ascending: false });
        if (cloudHisto) dispatch({ type: 'LOAD_HISTORY', payload: cloudHisto.map(h => h.content) });
      } catch (e) {
        console.warn("Supabase load failed, falling back to local.");
      }
      dispatch({ type: 'SET_LOADING', payload: false });
    };
    initApp();
  }, []);

  useEffect(() => {
    localStorage.setItem('v15_signals', JSON.stringify(state.signals));
    localStorage.setItem('v15_history', JSON.stringify(state.history));
    localStorage.setItem('v15_muted_obj', JSON.stringify(state.mutedAssets));
  }, [state.signals, state.history, state.mutedAssets]);

  const toggleAsset = (symbol: string) => dispatch({ type: 'TOGGLE_ASSET', payload: symbol });
  const clearNotification = () => dispatch({ type: 'CLEAR_NOTIFICATION' });
  const deleteSignal = async (id: string, asset: string) => {
    try {
      const res = await fetch(apiUrl(`/api/signals/${id}`), {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.VITE_APP_PASSWORD || ''}` },
      });
      if (res.ok) {
        dispatch({ type: 'DELETE_SIGNAL', payload: { id, asset } });
      }
    } catch (e) {
      console.error("Erreur suppression signal:", e);
    }
  };

  useEffect(() => {
    let intervalId: any;
    
    const syncWithServer = async () => {
      console.log("🔄 Syncing with server...");
      try {
        const [sigsRes, histRes, statusRes, scannerRes] = await Promise.all([
          fetch(apiUrl('/api/signals')).catch(e => { console.error("Fetch /api/signals failed:", e); throw e; }),
          fetch(apiUrl('/api/history')).catch(e => { console.error("Fetch /api/history failed:", e); throw e; }),
          fetch(apiUrl('/api/engine/status')).catch(e => { console.error("Fetch /api/engine/status failed:", e); throw e; }),
          fetch(apiUrl('/api/scanner')).catch(e => { console.error("Fetch /api/scanner failed:", e); throw e; })
        ]);
        console.log("✅ Fetch responses received", { 
          sigs: sigsRes.status, 
          hist: histRes.status, 
          status: statusRes.status, 
          scanner: scannerRes.status 
        });

        const checkJson = async (res: Response) => {
          const contentType = res.headers.get('content-type');
          if (!res.ok || !contentType || !contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`Invalid response from ${res.url}: ${res.status} ${res.statusText}. Content-Type: ${contentType}. Body: ${text.substring(0, 100)}...`);
          }
          return res.json();
        };

        if (sigsRes.ok && histRes.ok && statusRes.ok && scannerRes.ok) {
          const sigs = await checkJson(sigsRes);
          const hist = await checkJson(histRes);
          const status = await checkJson(statusRes);
          const scanner = await checkJson(scannerRes);

          dispatch({ type: 'LOAD_ACTIVE_SIGNALS', payload: sigs });
          dispatch({ type: 'LOAD_HISTORY', payload: hist });
          dispatch({ type: 'SET_ENGINE', payload: status.isRunning });
          dispatch({ type: 'SET_LAST_SCAN_TIME', payload: status.lastScanTime });
          dispatch({ type: 'UPDATE_PERFORMANCE', payload: status.lastBatchTimeMs });
          dispatch({ type: 'LOAD_MUTED', payload: status.mutedAssets || {} });
          
          if (status.activeStrategyId && status.activeStrategyId !== state.activeStrategy.id) {
            const s = STRATEGIES.find(x => x.id === status.activeStrategyId);
            if (s) dispatch({ type: 'SET_ACTIVE_STRATEGY', payload: s });
          }
          
          // Mise à jour des logs et marketData pour le Scanner
          if (scanner.scanLogs) {
            // On remplace les logs locaux par ceux du serveur
            // Note: On pourrait faire un merge plus intelligent si besoin
            dispatch({ type: 'SET_SCAN_LOGS', payload: scanner.scanLogs });
          }
          if (scanner.marketData) {
            Object.entries(scanner.marketData).forEach(([symbol, data]: [string, any]) => {
              dispatch({ type: 'REFRESH_MARKET_DATA', payload: { symbol, data } });
            });
          }
        }
      } catch (e) {
        console.error("Erreur de synchronisation avec le serveur:", e);
      }
    };

    syncWithServer();
    // 30s au lieu de 10s — le moteur serveur tourne en continu,
    // pas besoin de poll agressif côté client (économie CPU/batterie)
    intervalId = setInterval(syncWithServer, 30000);

    // Pause polling quand l'onglet est masqué (économie batterie mobile)
    const onVisibility = () => {
      if (document.hidden) {
        clearInterval(intervalId);
      } else {
        syncWithServer();
        intervalId = setInterval(syncWithServer, 30000);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const toggleEngine = async () => {
    try {
      const res = await fetch(apiUrl('/api/engine/toggle'), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        dispatch({ type: 'SET_ENGINE', payload: data.isRunning });
      }
    } catch (e) {
      console.error("Erreur toggle engine:", e);
    }
  };
  return (
    <SignalsContext.Provider value={{ 
      ...state, toggleEngine, toggleAsset, clearNotification, deleteSignal,
      updateSignalExplanation: (id: string, text: string) => dispatch({ type: 'UPDATE_SIGNAL_AI', payload: { id, text } }),
      setStrategy: async (id: string) => {
        try {
          const res = await fetch(apiUrl('/api/engine/strategy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategyId: id })
          });
          if (res.ok) {
            const s = STRATEGIES.find(x => x.id === id);
            if (s) dispatch({ type: 'SET_ACTIVE_STRATEGY', payload: s });
          }
        } catch (e) {
          console.error("Erreur changement stratégie:", e);
        }
      },
      updateEmailConfig: (cfg: EmailConfig) => dispatch({ type: 'UPDATE_EMAIL_CONFIG', payload: cfg }),
      clearMuted: async () => {
        try {
          const res = await fetch(apiUrl('/api/engine/unmute'), { method: 'POST' });
          if (res.ok) {
            dispatch({ type: 'CLEAR_MUTED' });
          }
        } catch (e) {
          console.error("Erreur clear muted:", e);
        }
      },
      resetToDefaults: () => dispatch({ type: 'RESET_DEFAULTS' })
    }}>
      {children}
    </SignalsContext.Provider>
  );
};

export const useSignals = () => useContext(SignalsContext);
