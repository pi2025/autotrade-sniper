
import React, { useState, useEffect } from 'react';
import { Lock, Key, ShieldCheck, AlertCircle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

// Sécurisation via Variable d'Environnement avec fallback
const APP_PASSWORD = process.env.VITE_APP_PASSWORD || 'QUANTUM'; 

export const LoginGate: React.FC<Props> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    const auth = localStorage.getItem('v15_auth');
    if (auth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === APP_PASSWORD) {
      localStorage.setItem('v15_auth', 'true');
      setIsAuthenticated(true);
      setError(false);
    } else {
      setError(true);
      setPassword('');
    }
  };

  if (isAuthenticated) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 max-w-md w-full shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-violet-600 via-cyan-500 to-emerald-500" />
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-violet-500/10 rounded-full blur-3xl" />
        
        <div className="text-center mb-8 relative z-10">
          <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 border border-slate-700">
            <Lock className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-2xl font-black text-white mb-2 uppercase tracking-tight">Quantum Terminal V15</h1>
          <p className="text-slate-400 text-sm font-medium">Authentification requise pour accéder au moteur de trading.</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4 relative z-10">
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5 block">Access Token</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl py-4 pl-10 pr-4 text-white focus:outline-none focus:border-cyan-500 transition-colors font-mono"
                placeholder="••••••••"
                autoFocus
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-500/10 p-3 rounded-xl border border-rose-500/20 animate-pulse font-bold">
              <AlertCircle className="w-4 h-4" />
              ACCÈS REFUSÉ : Token Invalide.
            </div>
          )}

          <button 
            type="submit"
            className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-black py-4 rounded-xl transition-all shadow-xl shadow-cyan-900/20 active:scale-95 flex items-center justify-center gap-3 uppercase text-xs tracking-widest"
          >
            <ShieldCheck className="w-5 h-5" />
            Déverrouiller
          </button>
        </form>
        
        <div className="mt-8 text-center border-t border-slate-800 pt-4">
           <p className="text-[9px] font-black text-slate-600 uppercase tracking-tighter">Secure Access Layer • Quantum Architecture</p>
        </div>
      </div>
    </div>
  );
};
