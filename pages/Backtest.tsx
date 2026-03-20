import React, { useState, useEffect } from 'react';
import { useSignals } from '../context/SignalsContext';
import { runStrategyTournament } from '../services/backtestEngine';
import { StrategyParams, BacktestResult } from '../types';
import { STRATEGIES, DEFAULT_STRATEGY } from '../services/marketEngine';
import { History, Sliders, Play, Loader2, TrendingUp, TrendingDown, Percent, Target, Hourglass } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const Backtest: React.FC = () => {
  const { marketData, assets } = useSignals();
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [editableStrategy, setEditableStrategy] = useState<StrategyParams>(DEFAULT_STRATEGY);

  const handleParamChange = (param: keyof StrategyParams, value: string) => {
    if (['adxThreshold', 'stopLossAtrMultiplier', 'breakevenTriggerR', 'maxHoldPeriod'].includes(param as string)) {
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
            setEditableStrategy(prev => ({ ...prev, [param]: numValue }));
        }
    } else {
        setEditableStrategy(prev => ({ ...prev, [param]: value as any }));
    }
  };

  const handleRunBacktest = async () => {
    setIsLoading(true);
    setProgress(0);
    setResults([]);

    try {
      const activeMarketData = Object.keys(marketData)
        .filter(key => assets.find(a => a.symbol === key && a.active))
        .reduce((obj, key) => {
          obj[key] = marketData[key];
          return obj;
        }, {} as Record<string, any>);

      const res = await runStrategyTournament(activeMarketData, [editableStrategy], setProgress);
      setResults(res);
    } catch (error) {
      console.error("Erreur durant le backtest:", error);
      alert("Une erreur est survenue pendant la simulation. Vérifiez la console.");
    } finally {
      setIsLoading(false);
    }
  };
  
  const exitLogicOptions = [
    { value: 'ATR_TRAIL', label: 'Stop Suiveur ATR (Classique)' },
    { value: 'ADX_FALL', label: 'Sortie sur Chute ADX' },
    { value: 'EMA_20_TOUCH', label: 'Sortie sur Contact EMA 20' },
  ];

  const result = results[0];

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-20">
      <div className="flex items-center gap-4">
        <History className="w-8 h-8 text-amber-400" />
        <div>
          <h1 className="text-3xl font-black text-white">Laboratoire de Backtesting</h1>
          <p className="text-slate-500 text-sm">Optimisez et validez les stratégies sur les données historiques (~15 jours).</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* === CONFIGURATION PANEL === */}
        <div className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl self-start">
          <div className="flex items-center gap-3 mb-6 pb-6 border-b border-slate-800">
            <Sliders className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-bold text-white">Configuration</h2>
          </div>

          <div className="space-y-4">
            <ParamInput 
              label="Seuil ADX" 
              value={editableStrategy.adxThreshold}
              onChange={e => handleParamChange('adxThreshold', e.target.value)}
              step={1}
            />
            <ParamInput 
              label="Multiplicateur ATR (Stop)" 
              value={editableStrategy.stopLossAtrMultiplier}
              onChange={e => handleParamChange('stopLossAtrMultiplier', e.target.value)}
              step={0.1}
            />
             <ParamInput 
              label="Déclencheur Breakeven (R)" 
              value={editableStrategy.breakevenTriggerR}
              onChange={e => handleParamChange('breakevenTriggerR', e.target.value)}
              step={0.1}
            />
            <ParamInput 
              label="Durée Max Trade (Bougies)" 
              value={editableStrategy.maxHoldPeriod}
              onChange={e => handleParamChange('maxHoldPeriod', e.target.value)}
              step={10}
            />
            <SelectInput
              label="Logique de Sortie Avancée"
              value={editableStrategy.exitLogic}
              onChange={e => handleParamChange('exitLogic', e.target.value)}
              options={exitLogicOptions}
            />

            <div className="pt-6">
              <button 
                onClick={handleRunBacktest}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl font-black text-sm uppercase transition-all shadow-lg active:scale-95 bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:from-amber-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                {isLoading ? `ANALYSE EN COURS... ${progress}%` : 'LANCER LE BACKTEST'}
              </button>
            </div>
          </div>
        </div>

        {/* === RESULTS PANEL === */}
        <div className="lg:col-span-2 space-y-8">
          {!result && !isLoading && (
             <div className="h-full min-h-[400px] flex flex-col items-center justify-center bg-slate-900/50 border-2 border-dashed border-slate-800 rounded-3xl text-center p-8">
                <History className="w-12 h-12 text-slate-700 mb-4" />
                <h3 className="font-bold text-slate-400">En attente de simulation</h3>
                <p className="text-xs text-slate-500">Configurez et lancez le backtest pour voir les résultats.</p>
             </div>
          )}
          {isLoading && (
             <div className="h-full min-h-[400px] flex flex-col items-center justify-center bg-slate-900/50 border border-slate-800 rounded-3xl p-8">
                <Loader2 className="w-12 h-12 animate-spin text-amber-500 mb-4" />
                <p className="text-sm font-bold text-slate-300 mb-2">Simulation en cours...</p>
                <div className="w-full max-w-sm bg-slate-800 rounded-full h-2.5">
                    <div className="bg-amber-500 h-2.5 rounded-full" style={{ width: `${progress}%` }}></div>
                </div>
             </div>
          )}
          {result && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <StatCard title="Profit Net (R)" value={result.netPnl.toFixed(2)} color={result.netPnl > 0 ? 'text-emerald-400' : 'text-rose-400'} icon={<TrendingUp/>}/>
                <StatCard title="Win Rate" value={`${result.winRate.toFixed(1)}%`} icon={<Percent/>}/>
                <StatCard title="Total Trades" value={result.totalTrades} icon={<Target/>}/>
                <StatCard title="Profit Factor" value={result.profitFactor} icon={<TrendingUp/>}/>
                <StatCard title="Durée Moy. Trade" value={`${result.avgTradeDuration.toFixed(1)} bougies`} icon={<Hourglass />} isText={true} />
                <StatCard title="Max Drawdown (R)" value={result.maxDrawdown.toFixed(2)} color="text-rose-400" icon={<TrendingDown/>}/>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 h-[400px] shadow-2xl flex flex-col">
                <h3 className="text-sm font-bold text-white mb-4 shrink-0">Courbe de Capitaux (Equity Curve)</h3>
                <div className="flex-grow w-full">
                  <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={result.equityCurve} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                          <XAxis dataKey="tradeNum" stroke="#64748b" fontSize={10} />
                          <YAxis stroke="#64748b" fontSize={10} allowDecimals={false} />
                          <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }} />
                          <ReferenceLine y={0} stroke="#475569" strokeDasharray="5 5" />
                          <Line type="monotone" dataKey="equity" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false}/>
                      </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const ParamInput = ({ label, value, onChange, step }: { label: string, value: number, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void, step: number }) => (
  <div>
    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">{label}</label>
    <input 
      type="number"
      value={value}
      onChange={onChange}
      step={step}
      className="w-full bg-slate-800 border border-slate-700 rounded-lg py-2 px-3 text-white font-mono focus:outline-none focus:border-cyan-500 transition-colors"
    />
  </div>
);

const SelectInput = ({ label, value, onChange, options }: { label: string, value: string, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void, options: { value: string, label: string }[] }) => (
  <div>
    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">{label}</label>
    <div className="relative">
      <select 
        value={value}
        onChange={onChange}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg py-2 px-3 text-white focus:outline-none focus:border-cyan-500 transition-colors appearance-none pr-8"
      >
        {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
        <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
      </div>
    </div>
  </div>
);

const StatCard = ({ title, value, color = "text-white", icon, isText = false }: { title: string, value: any, color?: string, icon: React.ReactNode, isText?: boolean }) => (
    <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center justify-between text-slate-500 mb-2">
            <span className="text-[9px] font-bold uppercase tracking-wider">{title}</span>
            {icon}
        </div>
        <p className={`font-mono font-black ${isText ? 'text-xs' : 'text-2xl'} ${color}`}>{value}</p>
    </div>
);

export default Backtest;