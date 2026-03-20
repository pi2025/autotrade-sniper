
import React, { useState, useMemo, useEffect } from 'react';
import { useSignals } from '../context/SignalsContext';
import SignalCard from '../components/SignalCard';
import { SignalType, SignalStatus } from '../types';
import { 
  PauseCircle, PlayCircle, Activity, Loader2, Target, Zap, Clock, 
  CheckCircle2, Globe, ShieldCheck, AlertTriangle, HelpCircle, Sparkles, Monitor
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

const formatSymbol = (symbol: string) => {
  if (symbol.includes('=')) return symbol.split('=')[0];
  if (symbol.includes('-')) return symbol.replace('-', '/');
  return symbol;
};

const Dashboard: React.FC = () => {
  const { 
    signals = [], 
    history = [], 
    isEngineRunning, 
    toggleEngine, 
    isLoading, 
    performance, 
    lastScanTime 
  } = useSignals();

  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'HISTORY'>('ACTIVE');
  const [showHelp, setShowHelp] = useState(false);
  const [hasAiKey, setHasAiKey] = useState(false);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasAiKey(selected);
      }
    };
    checkKey();
  }, []);

  const safeSignals = useMemo(() => 
    [...(Array.isArray(signals) ? signals : [])].sort((a, b) => b.timestamp - a.timestamp),
    [signals]
  );
  
  const safeHistory = useMemo(() => 
    [...(Array.isArray(history) ? history : [])].sort((a, b) => (b.closedAt || b.timestamp) - (a.closedAt || a.timestamp)),
    [history]
  );

  const activeCount = safeSignals.length;
  const realWins = safeHistory.filter(s => (s.pnl || 0) > 0.1).length;
  const breakevens = safeHistory.filter(s => (s.pnl || 0) >= -0.1 && (s.pnl || 0) <= 0.1).length;
  const realLosses = safeHistory.filter(s => (s.pnl || 0) < -0.1).length;
  
  const totalClosed = safeHistory.length;
  const winRate = totalClosed > 0 ? ((realWins + breakevens) / totalClosed) * 100 : 0;
  const netPnlR = safeHistory.reduce((acc, curr) => acc + (curr.pnl || 0), 0);

  const exposureMap = useMemo(() => {
    const map: Record<string, number> = {};
    safeSignals.forEach(s => {
      const clean = s.asset.replace('=X', '').replace('-USD', 'USD');
      if (clean.length === 6) {
        const base = clean.substring(0, 3);
        const quote = clean.substring(3, 6);
        const weight = s.type === SignalType.BUY ? 1 : -1;
        map[base] = (map[base] || 0) + weight;
        map[quote] = (map[quote] || 0) - weight;
      } else {
        map[clean] = (map[clean] || 0) + (s.type === SignalType.BUY ? 1 : -1);
      }
    });
    return map;
  }, [safeSignals]);

  const handleActivateIA = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasAiKey(true);
      window.location.reload();
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-white mb-1 flex items-center gap-3">
            <span className="bg-gradient-to-r from-cyan-400 to-blue-600 bg-clip-text text-transparent">QUANTUM</span> SNIPER V15
            {isEngineRunning && <span className="flex h-3 w-3"><span className="animate-ping absolute inline-flex h-3 w-3 rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span>}
          </h1>
          <p className="text-slate-500 text-sm font-medium flex items-center gap-2">
            <Globe className="w-4 h-4 text-slate-600" /> Moniteur de Trading MTF & Protection de Capital
          </p>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={handleActivateIA}
            className={`flex items-center gap-2 px-4 py-3 rounded-xl text-xs font-bold transition-all shadow-lg group border ${
              hasAiKey 
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
              : 'bg-slate-900 border-slate-700 text-cyan-400 hover:border-cyan-500'
            }`}
          >
            <Sparkles className={`w-4 h-4 ${!hasAiKey && 'animate-pulse'}`} />
            {hasAiKey ? 'IA CONFIGURÉE' : 'ACTIVER IA (SEARCH)'}
          </button>
          
          <button 
              onClick={toggleEngine}
              className={`flex items-center gap-3 px-8 py-4 rounded-2xl font-black transition-all shadow-2xl active:scale-95 ${
                  isEngineRunning 
                  ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20' 
                  : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:from-cyan-400 hover:to-blue-500 shadow-cyan-500/20'
              }`}
          >
              {isEngineRunning ? <PauseCircle className="w-5 h-5" /> : <PlayCircle className="w-5 h-5" />}
              {isEngineRunning ? 'STOP SCAN' : 'START V15'}
          </button>
        </div>
      </div>

      {isEngineRunning && (
        <div className="bg-cyan-500/10 border border-cyan-500/20 p-4 rounded-2xl flex items-center gap-4 animate-pulse">
          <ShieldCheck className="w-6 h-6 text-cyan-500 shrink-0" />
          <div className="text-xs text-cyan-200">
            <span className="font-bold block mb-0.5">MOTEUR ACTIF (MODE SERVEUR 24/7)</span>
            L'analyse s'effectue désormais sur le serveur. Vous pouvez fermer cet onglet, le Sniper continue de surveiller vos positions et d'envoyer des alertes Telegram.
          </div>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3 text-xs font-black text-slate-400 uppercase tracking-widest">
              <ShieldCheck className="w-5 h-5 text-emerald-500" /> Santé du Portefeuille
          </div>
          <button 
            onClick={() => setShowHelp(!showHelp)}
            className="flex items-center gap-1.5 text-[10px] font-bold text-cyan-500 hover:text-cyan-400 transition-colors"
          >
            <HelpCircle className="w-3.5 h-3.5" /> {showHelp ? 'Masquer l\'aide' : 'C\'est quoi ?'}
          </button>
        </div>

        {showHelp && (
          <div className="mb-6 p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-2xl text-xs text-slate-300 leading-relaxed animate-fade-in">
            <p className="mb-2"><strong>Aide Débutant :</strong> Le Sniper V15 Quantum utilise des filtres de "Choppiness" et de "Fan Widening" pour éviter les faux breakouts dans les marchés latéraux.</p>
            <p>Le taux d'efficacité inclut désormais les positions fermées à 0 (Breakeven) car elles ne coûtent rien à votre capital.</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {Object.entries(exposureMap).map(([currency, val]) => {
                const value = val as number;
                const absValue = Math.abs(value);
                const isCritical = absValue >= 3;
                const isWarning = absValue === 2;
                
                return value !== 0 && (
                    <div key={currency} className={`p-4 rounded-2xl border transition-all ${
                      isCritical ? 'bg-rose-500/10 border-rose-500/30' : 
                      isWarning ? 'bg-amber-500/10 border-amber-500/30' : 
                      'bg-slate-950 border-slate-800'
                    }`}>
                        <div className="flex justify-between items-center mb-1">
                            <span className="font-black text-xs text-white">{currency}</span>
                            {isCritical && <AlertTriangle className="w-3 h-3 text-rose-500 animate-pulse" />}
                        </div>
                        <div className={`text-xl font-mono font-bold ${isCritical ? 'text-rose-500' : isWarning ? 'text-amber-500' : 'text-emerald-400'}`}>
                          {value > 0 ? 'ACHAT' : 'VENTE'} x{absValue}
                        </div>
                    </div>
                );
            })}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24">
          <Loader2 className="w-12 h-12 animate-spin text-cyan-500 mb-6" />
          <p className="text-slate-400 font-bold tracking-[0.2em] uppercase text-xs">Extraction des flux Quantum...</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
             <StatCard 
                title="Positions Live" 
                value={activeCount} 
                icon={<Activity />} 
                color="text-white" 
                sub="Surveillance active"
             />
             <StatCard 
                title="Efficacité Sniper" 
                value={`${winRate.toFixed(1)}%`} 
                icon={<CheckCircle2 />} 
                color="text-emerald-400" 
                sub={
                  <div className="flex gap-2">
                    <span className="text-emerald-500">{realWins} Gains</span>
                    <span className="text-slate-400">{breakevens} BE</span>
                    <span className="text-rose-500">{realLosses} Pertes</span>
                  </div>
                } 
             />
             <StatCard 
                title="Profit Net" 
                value={`${netPnlR.toFixed(1)}R`} 
                icon={<Activity />} 
                color={netPnlR >= 0 ? "text-emerald-400" : "text-rose-400"} 
                sub="Unités de risque cumulées"
             />
             <StatCard 
                title="Performance Moteur" 
                value={`${performance?.lastBatchTimeMs || 0}ms`} 
                icon={<Zap />} 
                color="text-cyan-400" 
                sub={lastScanTime > 0 ? `Scan ${formatDistanceToNow(lastScanTime, { addSuffix: true })}` : "Scan en attente"}
             />
          </div>

          <div className="space-y-6">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex gap-8">
                    <button onClick={() => setActiveTab('ACTIVE')} className={`relative pb-4 text-xs font-black tracking-widest transition-all ${activeTab === 'ACTIVE' ? 'text-cyan-400' : 'text-slate-500 hover:text-white'}`}>
                        SIGNAUX EN COURS
                        {activeTab === 'ACTIVE' && <div className="absolute bottom-0 left-0 w-full h-1 bg-cyan-500 rounded-full shadow-[0_0_10px_#06b6d4]" />}
                    </button>
                    <button onClick={() => setActiveTab('HISTORY')} className={`relative pb-4 text-xs font-black tracking-widest transition-all ${activeTab === 'HISTORY' ? 'text-blue-400' : 'text-slate-500 hover:text-white'}`}>
                        VOS RÉSULTATS (HISTO)
                        {activeTab === 'HISTORY' && <div className="absolute bottom-0 left-0 w-full h-1 bg-blue-500 rounded-full shadow-[0_0_10px_#3b82f6]" />}
                    </button>
                </div>
            </div>

            {activeTab === 'ACTIVE' ? (
                safeSignals.length === 0 ? (
                  <div className="py-32 flex flex-col items-center justify-center bg-slate-900/20 rounded-3xl border-2 border-dashed border-slate-800/50">
                    <Target className="w-16 h-16 text-slate-800 mb-4" />
                    <h3 className="text-slate-500 font-bold uppercase text-xs tracking-widest">En attente d'opportunités sniper...</h3>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {safeSignals.map(signal => <SignalCard key={signal.id} signal={signal} />)}
                  </div>
                )
            ) : (
                <HistoryTable history={safeHistory} />
            )}
          </div>
        </>
      )}
    </div>
  );
};

const StatCard = ({ title, value, icon, color, sub }: any) => (
  <div className="bg-slate-900/80 border border-slate-800 p-6 rounded-3xl relative overflow-hidden group hover:border-slate-700 transition-all shadow-xl">
    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity text-slate-100">{icon}</div>
    <h3 className="text-slate-500 text-[10px] uppercase font-black mb-2 tracking-widest">{title}</h3>
    <div className={`text-3xl font-mono font-bold ${color}`}>{value}</div>
    <div className="text-[10px] text-slate-500 mt-2 font-bold uppercase tracking-tight">{sub}</div>
  </div>
);

const HistoryTable = ({ history }: { history: any[] }) => (
  <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
    <table className="w-full text-left text-sm text-slate-400">
      <thead className="bg-slate-950 text-[10px] uppercase font-black text-slate-600 border-b border-slate-800">
        <tr>
          <th className="p-6">Actif</th>
          <th className="p-6">Sens</th>
          <th className="p-6 text-right">Profit (R)</th>
          <th className="p-6 text-right">Fermeture</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-800">
        {history.map((s: any) => (
          <tr key={s.id} className="hover:bg-slate-800/30 transition-colors group">
            <td className="p-6 font-black text-white group-hover:text-cyan-400 transition-colors">{formatSymbol(s.asset)}</td>
            <td className="p-6">
              <span className={`px-3 py-1 rounded-lg text-[9px] font-black border uppercase ${s.type === 'LONG' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'}`}>{s.type}</span>
            </td>
            <td className={`p-6 text-right font-mono font-black ${s.pnl > 0.1 ? 'text-emerald-400' : (s.pnl < -0.1 ? 'text-rose-500' : 'text-slate-400')}`}>
                {s.pnl > 0.1 ? '+' : ''}{s.pnl?.toFixed(2)}R
                {Math.abs(s.pnl || 0) <= 0.1 && <span className="text-[8px] ml-1 opacity-50 uppercase">BE</span>}
            </td>
            <td className="p-6 text-right text-[10px] text-slate-600 font-mono italic">{s.closedAt ? formatDistanceToNow(s.closedAt, { addSuffix: true }) : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default Dashboard;
