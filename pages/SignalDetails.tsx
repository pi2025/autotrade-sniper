
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSignals } from '../context/SignalsContext';
import { SignalType } from '../types';
import { 
  ArrowLeft, Bot, Calculator, ArrowUpRight, ArrowDownRight, Activity, Zap, Check, X, AlertTriangle, ExternalLink, Globe, Newspaper, Hourglass, Trash2, ShieldAlert
} from 'lucide-react';
import { YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart, Line, CartesianGrid, ReferenceArea } from 'recharts';

const SignalDetails: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { signals = [], marketData = {}, updateSignalExplanation, deleteSignal } = useSignals();
  
  const [loadingAi, setLoadingAi] = useState(false);
  const [aiData, setAiData] = useState<{text: string, sources: any[], macroScore: number}>({ text: "", sources: [], macroScore: 50 });
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const signal = (signals || []).find(s => s.id === id);
  const currentMarketData = signal ? marketData[signal.asset] : null;

  useEffect(() => {
    if (signal && !aiData.text && !loadingAi) {
      const fetchAi = async () => {
        setLoadingAi(true);
        const res = await fetch(`/api/signals/${signal.id}/analyze`, { method: 'POST' });
        const data = await res.json();
        setAiData(data);
        updateSignalExplanation(signal.id, data.text);
        setLoadingAi(false);
      };
      fetchAi();
    }
  }, [signal]);

  const handleForceClose = () => {
    if (!signal) return;
    setShowConfirmModal(false);
    setTimeout(() => {
        deleteSignal(signal.id, signal.asset);
        navigate('/');
    }, 100);
  };

  if (!signal || !currentMarketData) return (
    <div className="p-32 text-center flex flex-col items-center gap-6">
        <Activity className="w-12 h-12 animate-spin text-cyan-500" />
        <p className="text-slate-500 font-black uppercase tracking-widest text-xs">Extraction des flux Quantum...</p>
    </div>
  );

  const isBuy = signal.type === SignalType.BUY;
  const currentPrice = currentMarketData.price || signal.priceAtSignal;
  const ind = signal.indicators;
  const chandelier = ind?.chandelierExit || signal.tradeSetup.stopLoss;
  const isExitTriggered = isBuy ? currentPrice <= chandelier : currentPrice >= chandelier;

  const chartData = (currentMarketData.history || []).map((price, idx) => ({ 
      i: idx, 
      price, 
      ema200: ind.ema200, 
      emaH4: ind.emaH4,
      chandelier: chandelier,
      upperDonchian: ind.donchian.upper,
      lowerDonchian: ind.donchian.lower,
      upperBand: ind.bollingerBands.upper,
      lowerBand: ind.bollingerBands.lower,
      tp: signal.tradeSetup.takeProfit,
      sl: signal.tradeSetup.stopLoss
  })).slice(-100);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-32">
      {showConfirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xl animate-in fade-in duration-300" onClick={() => setShowConfirmModal(false)} />
          <div className="bg-slate-900 border border-rose-500/30 rounded-[2.5rem] p-10 max-w-lg w-full relative z-10 shadow-[0_0_50px_rgba(244,63,94,0.15)] animate-in zoom-in-95 duration-200">
            <div className="w-20 h-20 bg-rose-500/10 rounded-3xl flex items-center justify-center mb-8 mx-auto border border-rose-500/20 rotate-12 shadow-inner">
              <AlertTriangle className="w-10 h-10 text-rose-500 -rotate-12" />
            </div>
            
            <h2 className="text-3xl font-black text-white text-center mb-2 tracking-tight">Fermeture Critique</h2>
            <p className="text-slate-500 text-center text-sm font-medium mb-8">Signal : {signal.asset} • Position {signal.type}</p>
            
            <div className="space-y-4 mb-10">
              <div className="bg-slate-950/50 p-6 rounded-3xl border border-slate-800 space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center shrink-0 mt-0.5">
                    <X className="w-4 h-4 text-rose-500" />
                  </div>
                  <div>
                    <h4 className="text-xs font-black text-rose-400 uppercase tracking-widest mb-1">Muting Algorithmique</h4>
                    <p className="text-xs text-slate-400 leading-relaxed font-medium">L'actif sera placé en liste noire et totalement ignoré par le scanner V18 pendant 30 min.</p>
                  </div>
                </div>
                
                <div className="flex items-start gap-4 pt-4 border-t border-slate-800/50">
                  <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                    <Trash2 className="w-4 h-4 text-amber-500" />
                  </div>
                  <div>
                    <h4 className="text-xs font-black text-amber-400 uppercase tracking-widest mb-1">Exclusion des Statistiques</h4>
                    <p className="text-xs text-slate-400 leading-relaxed font-medium">Ce trade ne sera pas archivé. Il sera supprimé sans impact sur votre PnL cumulé.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <button 
                onClick={handleForceClose}
                className="w-full py-5 rounded-2xl bg-rose-500 text-white font-black text-sm uppercase tracking-widest hover:bg-rose-600 transition-all shadow-xl shadow-rose-500/20 active:scale-95"
              >
                Confirmer la Fermeture
              </button>
              <button 
                onClick={() => setShowConfirmModal(false)}
                className="w-full py-4 rounded-2xl bg-slate-800/50 text-slate-400 font-bold text-xs uppercase tracking-widest hover:bg-slate-800 hover:text-white transition-all"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <button onClick={() => navigate('/')} className="flex items-center gap-2 text-slate-500 hover:text-white transition-all font-bold text-xs uppercase tracking-widest"><ArrowLeft className="w-4 h-4" /> Retour Dashboard</button>
        <button 
            onClick={() => setShowConfirmModal(true)}
            className="flex items-center gap-2 text-rose-500 hover:bg-rose-500/10 px-4 py-2 rounded-xl transition-all font-bold text-[10px] uppercase tracking-widest border border-rose-500/20"
        >
            <Trash2 className="w-3.5 h-3.5" /> Forcer Fermeture
        </button>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-5"><Zap className="w-24 h-24 text-cyan-500" /></div>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-8 relative z-10">
          <div>
            <div className="flex items-center gap-4 mb-2">
                <h1 className="text-4xl font-black text-white">{signal.asset}</h1>
                <div className="flex gap-2">
                  <span className="px-3 py-1 bg-slate-800 rounded-xl text-[10px] font-black text-slate-400 border border-slate-700 uppercase">V18 Matrix</span>
                  <span className="px-3 py-1 bg-cyan-500/10 rounded-xl text-[10px] font-black text-cyan-400 border border-cyan-500/20 uppercase flex items-center gap-1">
                    <Hourglass className="w-3 h-3" /> {signal.estimatedDuration}
                  </span>
                </div>
            </div>
            <div className={`flex items-center gap-2 text-sm font-black tracking-widest uppercase ${isBuy ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isBuy ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
              {signal.type} POSITION LIVE
            </div>
          </div>
          
          <div className={`px-10 py-5 rounded-3xl border-2 font-black flex items-center gap-4 transition-all ${isExitTriggered ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 animate-pulse' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'}`}>
            {isExitTriggered ? <AlertTriangle className="w-8 h-8" /> : <ShieldAlert className="w-8 h-8" />}
            <div className="flex flex-col">
              <span className="text-[10px] uppercase opacity-70 tracking-widest">Decision Engine</span>
              <span className="text-2xl">{isExitTriggered ? 'LIQUIDER' : 'CONSERVER'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 h-[550px] shadow-xl relative">
            <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-8 flex items-center gap-2">
              <Activity className="w-4 h-4" /> Flux Quantum + Tendance H4
            </h3>
            <ResponsiveContainer width="100%" height="85%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={isBuy ? '#10b981' : '#f43f5e'} stopOpacity={0.2}/>
                            <stop offset="95%" stopColor={isBuy ? '#10b981' : '#f43f5e'} stopOpacity={0}/>
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <YAxis domain={['auto', 'auto']} hide />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#020617', border: '1px solid #1e293b', borderRadius: '16px', fontSize: '10px' }} 
                      itemStyle={{ fontWeight: 'bold' }}
                    />
                    
                    {/* @ts-ignore */}
                    <ReferenceArea y1={signal.priceAtSignal} y2={signal.tradeSetup.takeProfit} fill={isBuy ? "#10b981" : "#f43f5e"} fillOpacity={0.03} />
                    
                    <Line type="stepAfter" dataKey="upperDonchian" stroke="#06b6d4" strokeWidth={1} strokeOpacity={0.3} dot={false} strokeDasharray="5 5" />
                    <Line type="stepAfter" dataKey="lowerDonchian" stroke="#06b6d4" strokeWidth={1} strokeOpacity={0.3} dot={false} strokeDasharray="5 5" />
                    <Line type="monotone" dataKey="upperBand" stroke="#8b5cf6" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="lowerBand" stroke="#8b5cf6" strokeWidth={1} dot={false} strokeDasharray="4 4" />

                    <Area type="monotone" dataKey="price" stroke={isBuy ? '#10b981' : '#f43f5e'} strokeWidth={3} fill="url(#priceGradient)" isAnimationActive={false} />
                    <Line type="stepAfter" dataKey="chandelier" stroke="#f43f5e" strokeWidth={2} dot={false} strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="ema200" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="emaH4" stroke="#a78bfa" strokeWidth={2} dot={false} strokeDasharray="5 5"/>

                    <ReferenceLine y={signal.priceAtSignal} stroke="#475569" strokeDasharray="3 3" label={{ value: 'ENTRY', position: 'insideTopRight', fill: '#475569', fontSize: 9, fontWeight: 'bold' }} />
                    <ReferenceLine y={signal.tradeSetup.takeProfit} stroke="#10b981" strokeDasharray="2 2" label={{ value: 'TARGET (Trailing)', position: 'insideTopRight', fill: '#10b981', fontSize: 9, fontWeight: 'bold' }} />
                    <ReferenceLine y={signal.tradeSetup.stopLoss} stroke="#f43f5e" strokeDasharray="2 2" label={{ value: 'INITIAL SL', position: 'insideBottomRight', fill: '#f43f5e', fontSize: 9, fontWeight: 'bold' }} />
                </AreaChart>
            </ResponsiveContainer>
            <div className="flex gap-4 mt-4 text-[9px] font-black uppercase tracking-widest justify-center flex-wrap">
              <span className="flex items-center gap-1.5"><div className="w-2 h-0.5 bg-emerald-500"></div> Prix</span>
              <span className="flex items-center gap-1.5"><div className="w-2 h-0.5 bg-violet-400 border-t border-dashed"></div> EMA H4</span>
              <span className="flex items-center gap-1.5"><div className="w-2 h-0.5 bg-amber-500"></div> EMA 200</span>
              <span className="flex items-center gap-1.5"><div className="w-2 h-0.5 bg-rose-500 border-t border-dashed"></div> Chandelier Exit</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
             <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3 text-cyan-400 font-black uppercase text-sm">
                    <Bot className="w-6 h-6" />
                    Synthèse Macro Quantum
                </div>
                <div className="flex items-center gap-3">
                  {aiData.macroScore !== 50 && (
                    <div className={`text-xs font-bold px-2 py-1 rounded-lg ${aiData.macroScore >= 65 ? 'bg-emerald-500/20 text-emerald-400' : aiData.macroScore >= 45 ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                      Score Macro IA : {aiData.macroScore}/100
                    </div>
                  )}
                  {loadingAi && <Activity className="w-4 h-4 animate-spin text-slate-500" />}
                </div>
             </div>
             
             <div className="prose prose-invert max-w-none">
                <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-line font-medium">
                    {aiData.text || "Initialisation de l'IA Search..."}
                </p>
             </div>
             
             {aiData.sources && aiData.sources.length > 0 && (
                <div className="mt-8 pt-6 border-t border-slate-800">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                        <Globe className="w-3.5 h-3.5" /> Sources de Recherche
                    </h4>
                    <div className="flex flex-wrap gap-3">
                        {aiData.sources.map((source, idx) => (
                            <a 
                                key={idx} 
                                href={source.uri} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-bold text-cyan-400 hover:border-cyan-500/50 transition-all"
                            >
                                <Newspaper className="w-3 h-3" />
                                {source.title}
                                <ExternalLink className="w-2.5 h-2.5 opacity-50" />
                            </a>
                        ))}
                    </div>
                </div>
             )}
          </div>
        </div>

        <div className="space-y-8">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
            <h3 className="font-black text-white text-xs uppercase tracking-widest mb-8 flex items-center gap-2"><Zap className="w-4 h-4 text-cyan-400" /> Score de Conformité</h3>
            <div className="space-y-5">
               <ComplianceItem label="Alignement Tendance H4" status={ind.mtfAlignment?.isAligned} />
               <ComplianceItem label="Squeeze de Volatilité" status={ind.bollingerBands.isSqueezing} />
               <ComplianceItem label="Momentum ADX (>32)" status={ind.adx > 32} />
               <ComplianceItem label="Structure Donchian" status={isBuy ? currentPrice > ind.donchian.middle : currentPrice < ind.donchian.middle} />
               <div className="pt-4 mt-4 border-t border-slate-800">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-slate-500 uppercase font-black">Probabilité Quantum</span>
                    <span className="text-xl font-black text-emerald-400">{signal.winProbability}%</span>
                  </div>
               </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-xl">
             <div className="flex items-center gap-3 mb-8 text-emerald-400 font-black uppercase text-xs"><Calculator className="w-5 h-5" /> Risk Management V18</div>
             <div className="space-y-5">
                <LevelItem label="Prix de Marché" value={currentPrice} color="text-white" />
                <LevelItem label="Trailing Stop (ATR)" value={chandelier} color="text-rose-500" highlight={isExitTriggered} />
                <LevelItem label="Objectif Sniper" value={signal.tradeSetup.takeProfit} color="text-emerald-500" />
                
                <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800 mt-4">
                   <div className="text-[9px] text-slate-500 uppercase font-black mb-1">Taille de Position Sug.</div>
                   <div className="text-sm font-bold text-white">{(signal.tradeSetup.positionSizeUnit / 1000).toFixed(2)} Lots Standard</div>
                   <div className="text-[8px] text-slate-600 mt-1 italic">Calculé selon Kelly Criterion & Volatilité ATR</div>
                </div>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ComplianceItem = ({ label, status }: any) => (
    <div className="flex items-center justify-between p-4 bg-slate-950 rounded-2xl border border-slate-800">
        <span className="text-[10px] text-slate-400 font-bold uppercase">{label}</span>
        {status ? <Check className="w-4 h-4 text-emerald-500" /> : <X className="w-4 h-4 text-rose-500" />}
    </div>
);

const LevelItem = ({ label, value, color, highlight }: any) => (
    <div className={`p-4 bg-slate-950 rounded-2xl border ${highlight ? 'border-rose-500/50 shadow-[0_0_10px_rgba(244,63,94,0.2)]' : 'border-slate-800'}`}>
        <div className="text-[9px] text-slate-500 uppercase font-black mb-1">{label}</div>
        <div className={`text-xl font-mono font-black ${color}`}>{value.toFixed(value > 100 ? 2 : 5)}</div>
    </div>
);

export default SignalDetails;
