
import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useSignals } from '../context/SignalsContext';
import { Radar, Activity, CheckCircle2, AlertTriangle, Wifi, WifiOff, RefreshCcw, Power, Clock, VolumeX, ShieldCheck, Zap, Terminal, ArrowUp, ArrowDown, Layers, Coins, Globe, Landmark } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { AssetType } from '../types';

const formatSymbol = (symbol: string) => {
  return symbol.replace('=X', '').replace('=F', '').replace('-USD', '');
};

const Scanner: React.FC = () => {
  const { assets, marketData, isEngineRunning, scanProgress, lastScanTime, toggleEngine, mutedAssets = {}, activeStrategy, scanLogs = [] } = useSignals();
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'ALL' | AssetType>('ALL');

  const filteredAssets = useMemo(() => {
    const active = assets.filter(a => a.active);
    if (filter === 'ALL') return active;
    return active.filter(a => a.type === filter);
  }, [assets, filter]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [scanLogs]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-20">
      
      {/* Header Panel */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
         <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            
            <div className="flex items-center gap-4">
               <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isEngineRunning ? 'bg-cyan-500/10 text-cyan-400' : 'bg-slate-800 text-slate-500'}`}>
                  <Radar className={`w-6 h-6 ${isEngineRunning ? 'animate-pulse' : ''}`} />
               </div>
               <div>
                  <h1 className="text-xl font-bold text-white flex items-center gap-2">
                     Scanner Matrix V17
                     {isEngineRunning && <span className="text-[10px] bg-cyan-500/10 text-cyan-400 px-2 py-0.5 rounded border border-cyan-500/20 uppercase font-bold tracking-tighter">Omega Engine</span>}
                  </h1>
                  <p className="text-xs text-slate-400 font-mono">
                     ADX: {activeStrategy.adxThreshold} | FILTRE: TRIPLE FAN (20/50/200)
                  </p>
               </div>
            </div>

            <div className="flex-1 max-w-md w-full">
                <div className="flex justify-between text-[10px] text-slate-500 mb-2 font-black uppercase tracking-widest">
                    <span>CYCLE OMEGA</span>
                    <span>{scanProgress}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                    <div 
                        className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500 transition-all duration-300 ease-out"
                        style={{ width: `${scanProgress}%` }}
                    />
                </div>
            </div>

            <button 
               onClick={toggleEngine}
               className={`flex items-center gap-2 px-6 py-3 rounded-xl font-black transition-all shadow-lg active:scale-95 ${
                  isEngineRunning 
                  ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20' 
                  : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-500/20'
               }`}
            >
               <Power className="w-5 h-5" />
               {isEngineRunning ? 'STOP OMEGA' : 'START OMEGA'}
            </button>
         </div>

         {/* Filter Tabs */}
         <div className="flex gap-2 mt-6 pt-6 border-t border-slate-800">
            <FilterTab active={filter === 'ALL'} onClick={() => setFilter('ALL')} icon={<Layers className="w-3.5 h-3.5" />} label="Tout" />
            <FilterTab active={filter === AssetType.CRYPTO} onClick={() => setFilter(AssetType.CRYPTO)} icon={<Coins className="w-3.5 h-3.5" />} label="Crypto" />
            <FilterTab active={filter === AssetType.FOREX} onClick={() => setFilter(AssetType.FOREX)} icon={<Landmark className="w-3.5 h-3.5" />} label="Forex" />
            <FilterTab active={filter === AssetType.INDEX} onClick={() => setFilter(AssetType.INDEX)} icon={<Globe className="w-3.5 h-3.5" />} label="Indices" />
         </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Matrix Grid (Left) */}
        <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredAssets.map(asset => {
              const data = marketData[asset.symbol];
              const cooldownExpiry = mutedAssets[asset.symbol];
              const isMuted = cooldownExpiry && Date.now() < cooldownExpiry;
              
              const hasData = !!data && !data.error;
              const isError = !!data && data.error;
              
              const ind = data?.lastIndicators;
              const adx = ind?.adx || 0;
              const adxOk = adx >= activeStrategy.adxThreshold;
              const adxRising = ind?.adxSlope === 'RISING';
              const squeezeOn = ind?.bollingerBands?.isSqueezing;
              const mtfOk = ind?.mtfAlignment?.isAligned;

              const price = data?.price || 0;
              const fanBull = ind && price > ind.ema20 && ind.ema20 > ind.ema50 && ind.ema50 > ind.ema200;
              const fanBear = ind && price < ind.ema20 && ind.ema20 < ind.ema50 && ind.ema50 < ind.ema200;
              const fanOk = fanBull || fanBear;

              return (
                  <div key={asset.symbol} className={`bg-slate-900 border rounded-2xl p-4 flex flex-col gap-3 transition-all relative overflow-hidden group ${
                      isMuted ? 'border-rose-500/20 bg-rose-500/5 opacity-60 grayscale' :
                      hasData 
                      ? 'border-slate-800 hover:border-cyan-500/30 shadow-lg' 
                      : isError ? 'border-rose-500/50 bg-rose-500/5' : 'border-slate-800/50 opacity-70'
                  }`}>
                      {hasData && (
                          <div className={`absolute top-0 left-0 w-full h-1 ${mtfOk && fanOk && adxOk && adxRising && squeezeOn ? 'bg-cyan-500 shadow-[0_0_10px_#06b6d4]' : 'bg-slate-800'}`} />
                      )}

                      <div className="flex justify-between items-center">
                          <span className={`font-black text-xs tracking-tight ${isMuted ? 'text-rose-400' : 'text-white'}`}>{formatSymbol(asset.symbol)}</span>
                          {isMuted ? (
                              <VolumeX className="w-3.5 h-3.5 text-rose-500" />
                          ) : hasData ? (
                              <div className="flex items-center gap-1.5">
                                  <span className="text-[8px] font-black text-slate-600 uppercase tracking-tighter">{asset.type}</span>
                                  <div className={`w-1.5 h-1.5 rounded-full ${fanOk ? 'bg-cyan-500 animate-pulse' : 'bg-slate-700'}`} />
                              </div>
                          ) : (
                              <WifiOff className="w-3.5 h-3.5 text-slate-700" />
                          )}
                      </div>
                      
                      <div className="flex justify-between items-end">
                          <div className="text-base font-mono font-black text-slate-200">
                              {hasData ? (
                                  data.price.toFixed(data.price < 10 ? 4 : 2)
                              ) : isError ? (
                                  <span className="text-rose-500 text-[10px] uppercase">Timeout</span>
                              ) : (
                                  <RefreshCcw className="w-3 h-3 animate-spin text-slate-700" />
                              )}
                          </div>
                          {hasData && (
                              <div className={`text-[9px] font-black px-1 py-0.5 rounded ${fanOk ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-800 text-slate-500'}`}>
                                 {ind?.trendContext}
                              </div>
                          )}
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-2 pt-3 border-t border-slate-800/50">
                          <div className="flex flex-col">
                              <span className="text-[7px] text-slate-600 font-black uppercase">ADX</span>
                              <div className="flex items-center gap-1">
                                  {adxRising ? <ArrowUp className="w-2.5 h-2.5 text-emerald-400" /> : <ArrowDown className="w-2.5 h-2.5 text-rose-400" />}
                                  <span className={`text-[10px] font-mono font-bold ${adxOk ? 'text-white' : 'text-slate-500'}`}>
                                      {adx.toFixed(1)}
                                  </span>
                              </div>
                          </div>
                          <div className="flex flex-col">
                              <span className="text-[7px] text-slate-600 font-black uppercase">SQUEEZE</span>
                              <div className="flex items-center gap-1">
                                  {hasData && <Zap className={`w-2.5 h-2.5 ${squeezeOn ? 'text-amber-400 animate-pulse' : 'text-slate-700'}`} />}
                                  <span className={`text-[10px] font-mono font-bold ${squeezeOn ? 'text-amber-400' : 'text-slate-500'}`}>
                                      {hasData ? (squeezeOn ? 'ON' : 'OFF') : '-'}
                                  </span>
                              </div>
                          </div>
                          <div className="flex flex-col">
                              <span className="text-[7px] text-slate-600 font-black uppercase">MTF H4</span>
                              <div className="flex items-center gap-1">
                                  {hasData && <Layers className={`w-2.5 h-2.5 ${mtfOk ? 'text-emerald-400' : 'text-slate-700'}`} />}
                                  <span className={`text-[10px] font-mono font-bold ${mtfOk ? 'text-emerald-400' : 'text-slate-500'}`}>
                                      {hasData ? (mtfOk ? 'ALIGN' : 'NO') : '-'}
                                  </span>
                              </div>
                          </div>
                      </div>

                      {isMuted && (
                          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-[1px] flex items-center justify-center">
                              <span className="text-rose-500 font-black text-[9px] uppercase border border-rose-500/30 px-2 py-1 rounded bg-slate-900 shadow-xl">Cooldown</span>
                          </div>
                      )}
                  </div>
              );
          })}
        </div>

        {/* Console Logs (Right) */}
        <div className="bg-slate-950 border border-slate-800 rounded-2xl flex flex-col h-[500px] lg:h-auto shadow-2xl relative overflow-hidden">
           <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <span className="text-[10px] font-black text-white uppercase tracking-widest">Diagnostic OMEGA</span>
           </div>
           <div ref={logContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-[9px] scroll-smooth">
              {scanLogs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600 italic text-center">En attente de données...</div>
              ) : (
                scanLogs.map((log: any) => (
                  <div key={log.id} className={`p-2 rounded border transition-colors ${
                    log.reason.includes('BREAKEVEN') ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-400 animate-pulse' :
                    log.status === 'SUCCESS' ? 'bg-emerald-500/5 border-emerald-500/10 text-emerald-400/80' :
                    log.status === 'ERROR' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' :
                    'bg-slate-800/30 border-slate-700/50 text-slate-500'
                  }`}>
                    <div className="flex justify-between mb-1 opacity-50">
                      <span>{new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                      <span className="font-bold">{log.asset}</span>
                    </div>
                    <p className="leading-tight">{log.reason}</p>
                  </div>
                ))
              )}
           </div>
        </div>
      </div>
    </div>
  );
};

const FilterTab = ({ active, onClick, icon, label }: any) => (
    <button 
        onClick={onClick}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all border ${
            active ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-lg shadow-cyan-500/5' : 'bg-slate-950 text-slate-500 border-slate-800 hover:text-slate-300'
        }`}
    >
        {icon}
        {label}
    </button>
);

export default Scanner;
