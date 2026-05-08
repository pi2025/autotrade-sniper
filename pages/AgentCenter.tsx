import React, { useState, useEffect } from 'react';
import { Shield, Zap, Eye, AlertTriangle, Save, RefreshCw } from 'lucide-react';

// Modes UI → valeurs serveur (claude/great-sammet)
type UIMode = 'SIGNALS_ONLY' | 'SEMI_AUTO' | 'AUTONOMOUS' | 'EMERGENCY_STOP';
const UI_TO_SERVER: Record<string, string> = {
  SIGNALS_ONLY:  'signals',
  SEMI_AUTO:     'semi-auto',
  AUTONOMOUS:    'autonomous',
};
const SERVER_TO_UI: Record<string, UIMode> = {
  signals:    'SIGNALS_ONLY',
  'semi-auto': 'SEMI_AUTO',
  autonomous: 'AUTONOMOUS',
};

const MODES: { id: UIMode; label: string; desc: string; color: string; icon: React.ReactNode }[] = [
  { id: 'SIGNALS_ONLY',  label: 'SIGNAUX SEULS',  desc: 'Détection uniquement, aucune exécution',             color: 'slate',   icon: <Eye className="w-5 h-5" /> },
  { id: 'SEMI_AUTO',     label: 'SEMI-AUTO',       desc: 'Validation manuelle via Telegram',                  color: 'amber',   icon: <Zap className="w-5 h-5" /> },
  { id: 'AUTONOMOUS',    label: 'AUTONOME',        desc: 'Exécution automatique avec gestion du risque',      color: 'emerald', icon: <Shield className="w-5 h-5" /> },
  { id: 'EMERGENCY_STOP',label: "ARRÊT D'URGENCE", desc: 'Ferme tout et arrête le moteur',                    color: 'rose',    icon: <AlertTriangle className="w-5 h-5" /> },
];

const colorMap: Record<string, string> = {
  slate:   'bg-slate-500/10 border-slate-500/30 text-slate-300',
  amber:   'bg-amber-500/10 border-amber-500/30 text-amber-400',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  rose:    'bg-rose-500/10 border-rose-500/30 text-rose-400',
};

const AUTH = () => `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}`;

interface Limits {
  maxSimultaneousTrades: number;
  maxRiskPercent: number;
  maxDrawdownPercent: number;
}

interface EngineStatus {
  isRunning: boolean;
  agentMode: string;
  riskLimits: {
    maxConcurrentTrades: number;
    maxTotalRiskPercent: number;
    maxDrawdownPercent: number;
    initialCapital?: number;
  };
  activeCount: number;
}

const AgentCenter: React.FC = () => {
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [limits, setLimits] = useState<Limits>({ maxSimultaneousTrades: 3, maxRiskPercent: 5, maxDrawdownPercent: 15 });
  const [saving, setSaving] = useState(false);
  const [modeLoading, setModeLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/engine/status');
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (!ct?.includes('application/json')) return;
      const data: EngineStatus = await res.json();
      setEngineStatus(data);
      if (data.riskLimits) {
        setLimits({
          maxSimultaneousTrades: data.riskLimits.maxConcurrentTrades ?? 3,
          maxRiskPercent:        data.riskLimits.maxTotalRiskPercent ?? 5,
          maxDrawdownPercent:    data.riskLimits.maxDrawdownPercent  ?? 15,
        });
      }
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const setMode = async (uiMode: UIMode) => {
    if (uiMode === 'AUTONOMOUS' && !confirm('Activer le mode AUTONOME ? Les ordres seront exécutés automatiquement.')) return;
    if (uiMode === 'EMERGENCY_STOP' && !confirm("ARRÊT D'URGENCE : fermer toutes les positions et arrêter le moteur ?")) return;

    setModeLoading(true);
    try {
      if (uiMode === 'EMERGENCY_STOP') {
        await fetch('/api/agent/emergency-stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': AUTH() },
          body: JSON.stringify({}),
        });
      } else {
        const serverMode = UI_TO_SERVER[uiMode];
        await fetch('/api/engine/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': AUTH() },
          body: JSON.stringify({ mode: serverMode }),
        });
      }
      await fetchStatus();
    } catch {}
    setModeLoading(false);
  };

  const saveLimits = async () => {
    setSaving(true);
    try {
      await fetch('/api/engine/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': AUTH() },
        body: JSON.stringify({
          maxConcurrentTrades: limits.maxSimultaneousTrades,
          maxTotalRiskPercent: limits.maxRiskPercent,
          maxDrawdownPercent:  limits.maxDrawdownPercent,
        }),
      });
      await fetchStatus();
    } catch {}
    setSaving(false);
  };

  const currentMode: UIMode = SERVER_TO_UI[engineStatus?.agentMode ?? ''] ?? 'SIGNALS_ONLY';
  const isConnected = false; // cTrader status not in engine/status, show as info only

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-black text-white mb-1">Agent Control Center</h1>
        <p className="text-slate-500 text-sm font-medium">Mode d'exécution & gestion du risque</p>
      </div>

      {/* Engine Status Bar */}
      <div className={`p-4 rounded-2xl border flex items-center gap-4 ${engineStatus?.isRunning ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20'}`}>
        <div className={`w-3 h-3 rounded-full ${engineStatus?.isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
        <div className="flex-1">
          <span className={`font-black text-xs uppercase ${engineStatus?.isRunning ? 'text-emerald-400' : 'text-rose-400'}`}>
            Moteur {engineStatus?.isRunning ? 'EN COURS' : 'ARRÊTÉ'}
          </span>
          {engineStatus && (
            <span className="text-slate-400 text-xs ml-4">
              Signaux actifs: <strong className="text-white">{engineStatus.activeCount}</strong>
            </span>
          )}
        </div>
        <button onClick={fetchStatus} className={`text-slate-500 hover:text-white transition-colors ${modeLoading ? 'animate-spin' : ''}`}>
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Mode Selector */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Mode d'exécution</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              disabled={modeLoading}
              className={`p-5 rounded-2xl border text-left transition-all ${
                currentMode === m.id
                  ? colorMap[m.color] + ' ring-1 ring-current'
                  : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600'
              } disabled:opacity-50`}
            >
              <div className="flex items-center gap-3 mb-2">
                {m.icon}
                <span className="font-black text-xs uppercase tracking-widest">{m.label}</span>
                {currentMode === m.id && <span className="ml-auto text-[9px] font-black uppercase opacity-60">ACTIF</span>}
              </div>
              <p className="text-[11px] opacity-70 leading-relaxed">{m.desc}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Risk Limits */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Limites de Risque</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
          {([
            { key: 'maxSimultaneousTrades' as const, label: 'Trades Simultanés Max', suffix: '' },
            { key: 'maxRiskPercent'        as const, label: 'Risque Total Max',       suffix: '%' },
            { key: 'maxDrawdownPercent'    as const, label: 'Drawdown Max',           suffix: '%' },
          ]).map(({ key, label, suffix }) => (
            <div key={key}>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">{label}</label>
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                <input
                  type="number"
                  value={limits[key]}
                  onChange={e => setLimits(prev => ({ ...prev, [key]: parseFloat(e.target.value) || 0 }))}
                  className="flex-1 bg-transparent py-3 px-4 text-white text-lg font-mono font-bold focus:outline-none"
                  min={0}
                />
                {suffix && <span className="pr-4 text-slate-500 font-bold">{suffix}</span>}
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={saveLimits}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl font-black text-xs transition-all shadow-lg active:scale-95 disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? 'SAUVEGARDE...' : 'SAUVEGARDER LIMITES'}
        </button>
      </section>
    </div>
  );
};

export default AgentCenter;
