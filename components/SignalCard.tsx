
import React, { useState } from 'react';
import { Signal, SignalType } from '../types';
import { ArrowUpRight, ArrowDownRight, Bot, Clock, Target, ShieldAlert, TrendingUp, Crosshair, Percent, Hourglass, Layers, Trash2, Loader2, AlertTriangle, X, Check } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useSignals } from '../context/SignalsContext';

interface Props {
  signal: Signal;
}

const SignalCard: React.FC<Props> = ({ signal }) => {
  const navigate = useNavigate();
  const { deleteSignal } = useSignals();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  
  const isBuy = signal.type === SignalType.BUY;

  const formatPrice = (price: number) => {
      if (price > 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (price > 1) return price.toFixed(4);
      return price.toFixed(5);
  };
  
  const getProbColor = (prob: number) => {
      if (prob >= 70) return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20';
      if (prob >= 55) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
  };
  
  const prob = signal.winProbability || 50;
  const probColorClass = getProbColor(prob);
  
  const mtf = signal.indicators?.mtfAlignment;
  const hasMTF = !!mtf;
  const isAligned = mtf?.isAligned || false;

  const confirmDelete = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setShowConfirm(true);
  };

  const handleFinalDelete = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDeleting(true);
      setShowConfirm(false);
      setTimeout(() => {
        deleteSignal(signal.id, signal.asset);
      }, 300);
  };

  const cancelDelete = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setShowConfirm(false);
  };

  return (
    <div 
      onClick={() => !isDeleting && !showConfirm && navigate(`/signal/${signal.id}`)}
      className={`bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-cyan-500/50 transition-all cursor-pointer group relative overflow-hidden shadow-lg ${isDeleting ? 'opacity-0 scale-95 translate-y-4' : 'opacity-100 scale-100'} duration-300 ease-in-out`}
    >
      {showConfirm && (
          <div className="absolute inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center animate-in fade-in zoom-in-95 duration-200">
              <div className="w-12 h-12 bg-rose-500/10 rounded-full flex items-center justify-center mb-3 border border-rose-500/20">
                <Trash2 className="w-6 h-6 text-rose-500 animate-pulse" />
              </div>
              <p className="text-[10px] font-black text-white uppercase tracking-widest mb-1">Ne pas prendre ce trade ?</p>
              <p className="text-[8px] text-slate-500 font-medium mb-5 uppercase tracking-tighter">Le signal sera supprimé. {signal.asset} sera ignoré pendant 30 min pour éviter le spam.</p>
              <div className="flex gap-2 w-full">
                  <button onClick={cancelDelete} className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-[9px] font-black text-slate-400 uppercase transition-all">Garder</button>
                  <button onClick={handleFinalDelete} className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 rounded-lg text-[9px] font-black text-white uppercase shadow-lg shadow-rose-500/20 transition-all active:scale-95">Supprimer</button>
              </div>
          </div>
      )}

      <div className="flex justify-between items-start mb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-white text-lg truncate">{signal.asset}</span>
            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black border ${
                hasMTF 
                ? (isAligned ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-500 border-slate-700')
                : 'bg-slate-950 text-slate-600 border-slate-800'
            }`}>
                <Layers className="w-2.5 h-2.5" /> 
                {isAligned ? 'MTF OK' : 'NO ALIGN'}
            </div>
          </div>
          <span className="text-[10px] text-slate-500 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDistanceToNow(signal.timestamp, { addSuffix: true })}
          </span>
        </div>
        
        <div className="flex items-center gap-2">
            <button 
                type="button"
                onClick={confirmDelete}
                className="z-40 p-3 -m-2 rounded-full text-slate-600 hover:text-rose-500 hover:bg-rose-500/10 transition-all border border-transparent active:scale-125 group/trash"
            >
                {isDeleting ? <Loader2 className="w-5 h-5 animate-spin text-rose-500" /> : <Trash2 className="w-5 h-5 group-hover/trash:scale-110 transition-transform" />}
            </button>
            <div className={`flex items-center gap-1 px-2 py-1 rounded-md font-bold text-[11px] ${
              isBuy ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              {isBuy ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
              {signal.type}
            </div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-2 mb-4">
          <div className={`flex items-center justify-between px-2.5 py-2 rounded-lg border ${probColorClass}`}>
              <Percent className="w-3.5 h-3.5" />
              <span className="text-base font-bold font-mono">{prob}%</span>
          </div>
          <div className="flex flex-col items-center justify-center px-2 py-1.5 rounded-lg border border-slate-800 bg-slate-950/50 text-slate-400">
              <span className="text-[8px] uppercase font-bold opacity-60">Trend Quality</span>
              <span className={`font-bold text-[11px] ${signal.indicators.choppiness < 40 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {signal.indicators.choppiness < 40 ? 'EXCELLENT' : 'STABLE'}
              </span>
          </div>
      </div>

      <div className="bg-slate-950 rounded-lg border border-slate-800/80 overflow-hidden mb-4">
         <div className="flex justify-between items-center p-2.5 border-b border-slate-800/80">
            <span className="text-[10px] text-slate-500 font-bold flex items-center gap-1.5"><Crosshair className="w-3.5 h-3.5" /> ENTRY</span>
            <span className="text-white font-mono font-bold text-sm">{formatPrice(signal.priceAtSignal)}</span>
         </div>
         <div className="grid grid-cols-2 divide-x divide-slate-800/80">
            <div className="flex flex-col p-2.5 bg-rose-500/5">
                <span className="text-[8px] text-rose-400/70 uppercase font-black mb-1">Stop Loss</span>
                <span className="text-rose-400 font-mono font-bold text-xs">{formatPrice(signal.tradeSetup.stopLoss)}</span>
            </div>
            <div className="flex flex-col items-end p-2.5 bg-emerald-500/5">
                <span className="text-[8px] text-emerald-400/70 uppercase font-black mb-1">Target</span>
                <span className="text-emerald-400 font-mono font-bold text-xs">TRAILING</span>
            </div>
         </div>
      </div>

      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <Bot className="w-3 h-3" />
              <span>{signal.aiExplanation ? "AI Verified" : "AI Analyzing..."}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-cyan-500/70 font-bold">
              <Hourglass className="w-3 h-3" />
              <span>{signal.estimatedDuration}</span>
          </div>
        </div>
        <div className="text-[9px] text-slate-600 font-bold uppercase tracking-tighter">
            V15 QUANTUM ENGINE
        </div>
      </div>
    </div>
  );
};

export default React.memo(SignalCard);
