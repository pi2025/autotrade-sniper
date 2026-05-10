import React, { useEffect, useState } from 'react';
import { AlertTriangle, Eye, RefreshCw, Save, Shield, Zap } from 'lucide-react';
import type { AgentLimits, AgentMode, AgentStatus } from '../types';

const MODES: { id: AgentMode; label: string; desc: string; color: string; icon: React.ReactNode }[] = [
  { id: 'SIGNALS_ONLY', label: 'SIGNAUX SEULS', desc: 'Detection uniquement, aucune execution', color: 'slate', icon: <Eye className="w-5 h-5" /> },
  { id: 'SEMI_AUTO', label: 'SEMI-AUTO', desc: 'Validation manuelle via Telegram', color: 'amber', icon: <Zap className="w-5 h-5" /> },
  { id: 'AUTONOMOUS', label: 'AUTONOME', desc: 'Execution automatique avec gestion du risque', color: 'emerald', icon: <Shield className="w-5 h-5" /> },
  { id: 'EMERGENCY_STOP', label: "ARRET D'URGENCE", desc: 'Ferme tout et arrete le moteur', color: 'rose', icon: <AlertTriangle className="w-5 h-5" /> },
];

const colorMap: Record<string, string> = {
  slate: 'bg-slate-500/10 border-slate-500/30 text-slate-300',
  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
  rose: 'bg-rose-500/10 border-rose-500/30 text-rose-400',
};

const AUTH = () => `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}`;

const DEFAULT_LIMITS: AgentLimits = {
  maxSimultaneousTrades: 3,
  maxRiskPercent: 5,
  maxDrawdownPercent: 15,
};

const AgentCenter: React.FC = () => {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [engineRunning, setEngineRunning] = useState(false);
  const [limits, setLimits] = useState<AgentLimits>(DEFAULT_LIMITS);
  const [saving, setSaving] = useState(false);
  const [modeLoading, setModeLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      const [agentRes, engineRes] = await Promise.all([
        fetch('/api/agent/status'),
        fetch('/api/engine/status'),
      ]);

      if (agentRes.ok) {
        const data: AgentStatus = await agentRes.json();
        setStatus(data);
        setLimits(data.limits);
      }

      if (engineRes.ok) {
        const data = await engineRes.json();
        setEngineRunning(Boolean(data.isRunning));
      }
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const setMode = async (mode: AgentMode) => {
    if (mode === 'AUTONOMOUS' && !confirm('Activer le mode AUTONOME ? Les ordres seront executes automatiquement.')) return;
    if (mode === 'EMERGENCY_STOP' && !confirm("ARRET D'URGENCE : fermer toutes les positions et arreter le moteur ?")) return;

    setModeLoading(true);
    try {
      const endpoint = mode === 'EMERGENCY_STOP' ? '/api/agent/emergency-stop' : '/api/agent/mode';
      const body = mode === 'EMERGENCY_STOP' ? {} : { mode };

      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH() },
        body: JSON.stringify(body),
      });
      await fetchStatus();
    } catch {}
    setModeLoading(false);
  };

  const saveLimits = async () => {
    setSaving(true);
    try {
      await fetch('/api/agent/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH() },
        body: JSON.stringify(limits),
      });
      await fetchStatus();
    } catch {}
    setSaving(false);
  };

  const currentMode = status?.mode ?? 'SIGNALS_ONLY';
  const isConnected = Boolean(status?.connected);

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-black text-white mb-1">Agent Control Center</h1>
        <p className="text-slate-500 text-sm font-medium">Mode d'execution & gestion du risque</p>
      </div>

      <div className={`p-4 rounded-2xl border flex items-center gap-4 ${engineRunning ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20'}`}>
        <div className={`w-3 h-3 rounded-full ${engineRunning ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
        <div className="flex-1">
          <span className={`font-black text-xs uppercase ${engineRunning ? 'text-emerald-400' : 'text-rose-400'}`}>
            Moteur {engineRunning ? 'EN COURS' : 'ARRETE'}
          </span>
          {status && (
            <span className="text-slate-400 text-xs ml-4">
              cTrader: <strong className={isConnected ? 'text-emerald-400' : 'text-rose-400'}>{isConnected ? 'connecte' : 'deconnecte'}</strong>
              &nbsp;· Positions: <strong className="text-white">{status.openPositions}</strong>
              &nbsp;· Solde: <strong className="text-white">{status.balance.toFixed(2)}</strong>
            </span>
          )}
        </div>
        <button onClick={fetchStatus} className={`text-slate-500 hover:text-white transition-colors ${modeLoading ? 'animate-spin' : ''}`}>
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Mode d'execution</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setMode(mode.id)}
              disabled={modeLoading}
              className={`p-5 rounded-2xl border text-left transition-all ${
                currentMode === mode.id
                  ? `${colorMap[mode.color]} ring-1 ring-current`
                  : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600'
              } disabled:opacity-50`}
            >
              <div className="flex items-center gap-3 mb-2">
                {mode.icon}
                <span className="font-black text-xs uppercase tracking-widest">{mode.label}</span>
                {currentMode === mode.id && <span className="ml-auto text-[9px] font-black uppercase opacity-60">ACTIF</span>}
              </div>
              <p className="text-[11px] opacity-70 leading-relaxed">{mode.desc}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
        <h2 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-6">Limites de Risque</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-6">
          {([
            { key: 'maxSimultaneousTrades' as const, label: 'Trades Simultanes Max', suffix: '' },
            { key: 'maxRiskPercent' as const, label: 'Risque Total Max', suffix: '%' },
            { key: 'maxDrawdownPercent' as const, label: 'Drawdown Max', suffix: '%' },
          ]).map(({ key, label, suffix }) => (
            <div key={key}>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 block">{label}</label>
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                <input
                  type="number"
                  value={limits[key]}
                  onChange={(event) => setLimits((prev) => ({ ...prev, [key]: parseFloat(event.target.value) || 0 }))}
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
