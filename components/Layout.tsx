
import React, { useEffect, useState, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Activity, Volume2, VolumeX, Radar, Database, Wifi, WifiOff, AlertTriangle, Settings, ShieldAlert, X, ArrowRight, CloudLightning, History } from 'lucide-react';
import { useSignals } from '../context/SignalsContext';
import { checkConnection } from '../services/supabaseClient';

const NOTIFICATION_SOUND = "data:audio/mp3;base64,//uQRAAAAWMSLwUIYAAsYkXgoQwAEaYLWfkWgAI0wWs/ItAAAG84AA0WAgAAAAAA//gAABLAAAAAlQAALGIAAAAAAAACEAAYDAAAAAAA//uQZAUAB1WI0PwgAAAAA0gAAABAAABH8AAACAAADSAAAAEAAAR//tQZAAAAAAAIAAAAEAABAAAAABAAIAAAQAAABQAAAAAAAAAAAAAA//tQZAYAAAEAAAAAAAEAAAAJAAABAAAAAQAAAAEAAAEAAAAAAAAAAAAAAP/7UGQmgAAACAAAAABAAABDAAAAQAAAAIAAAABAAAAgAAAAAAAAAAAAAD/+1BkzgAAAAgAAAAAQAAASgAAAIAAAAEAAAAEAAACAAAAAAAAAAAAAAP/7UGUAAABAAABAAAAAAAQAAAAAAoAAAAAAAAAAAAAAAMAAASYNMAwQFAAAQAAAAAA//tQZAYAAAEAAAAAAAEAAAAJAAABAAAAAQAAAAEAAAEAAAAAAAAAAAAAAP/7UGQmgAAACAAAAABAAABDAAAAQAAAAIAAAABAAAAgAAAAAAAAAAAAAD/+1BkzgAAAAgAAAAAQAAASgAAAIAAAAEAAAAEAAACAAAAAAAAAAAAAAP/7UGUAAABAAABAAAAAAAQAAAAAAoAAAAAAAAAAAAAAAMAAASYNMAwQFAAAQAAAAAA";

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { signals, latestNotification, clearNotification, scanProgress, isEngineRunning } = useSignals();
  const [showNotification, setShowNotification] = useState(false);
  const [notificationData, setNotificationData] = useState<any>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [dbStatus, setDbStatus] = useState<'checking' | 'connected' | 'error' | 'missing_config'>('checking');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioRef.current = new Audio(NOTIFICATION_SOUND);
    audioRef.current.volume = 0.5;
    const savedSound = localStorage.getItem('soundEnabled');
    if (savedSound !== null) setSoundEnabled(savedSound === 'true');
    const verifyDb = async () => {
        const status = await checkConnection();
        setDbStatus(status);
    };
    verifyDb();
  }, []);

  const toggleSound = () => {
    const newState = !soundEnabled;
    setSoundEnabled(newState);
    localStorage.setItem('soundEnabled', String(newState));
  };

  useEffect(() => {
    if (latestNotification) {
      setNotificationData(latestNotification);
      setShowNotification(true);
      document.title = `(${signals.length}) ${latestNotification.asset} - AutoTrade`;
      if (soundEnabled && audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(e => console.warn("Audio play failed", e));
      }
      const timer = setTimeout(() => {
        setShowNotification(false);
        clearNotification();
        document.title = "AutoTrade Titan V18";
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [latestNotification, clearNotification, signals.length, soundEnabled]);

  const getStatusConfig = () => {
      switch(dbStatus) {
          case 'connected': return { label: 'Hybride (Local+Cloud)', colorClass: 'text-emerald-400', bgClass: 'bg-emerald-500/5', borderClass: 'border-emerald-500/20', icon: CloudLightning, iconColor: 'text-emerald-500' };
          case 'error': return { label: 'Local Only (Cloud Error)', colorClass: 'text-rose-400', bgClass: 'bg-rose-500/5', borderClass: 'border-rose-500/20', icon: WifiOff, iconColor: 'text-rose-500' };
          case 'missing_config': return { label: 'Local Only (No Config)', colorClass: 'text-amber-400', bgClass: 'bg-amber-500/5', borderClass: 'border-amber-500/20', icon: AlertTriangle, iconColor: 'text-amber-500' };
          default: return { label: 'Initialisation...', colorClass: 'text-slate-500', bgClass: 'bg-slate-800', borderClass: 'border-slate-700', icon: Database, iconColor: 'text-slate-500' };
      }
  };

  const statusConfig = getStatusConfig();
  const StatusIcon = statusConfig.icon;

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
      <aside className="hidden lg:flex w-64 bg-slate-900 border-r border-slate-800 flex-col fixed h-full z-20">
        <div className="p-6 flex items-center gap-3 border-b border-slate-800 relative overflow-hidden">
          <div className="w-8 h-8 bg-gradient-to-br from-cyan-400 to-violet-500 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20 relative z-10">
             <Activity className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-xl tracking-tight relative z-10">AutoTrade</span>
          {isEngineRunning && scanProgress > 0 && (
             <div 
               className="absolute bottom-0 left-0 h-1 bg-cyan-500 transition-all duration-300 shadow-[0_0_10px_#06b6d4]"
               style={{ width: `${scanProgress}%` }}
             />
          )}
        </div>

        <nav className="flex-1 py-6 px-3 space-y-2">
          <NavLink to="/" className={({ isActive }) => `flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-cyan-500/10 text-cyan-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
            <LayoutDashboard className="w-5 h-5" /> <span>Tableau de Bord</span>
          </NavLink>
          <NavLink to="/scanner" className={({ isActive }) => `flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-violet-500/10 text-violet-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
            <Radar className="w-5 h-5" /> <span>Scanner Matrix</span>
          </NavLink>
          <NavLink to="/backtest" className={({ isActive }) => `flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-amber-500/10 text-amber-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
            <History className="w-5 h-5" /> <span>Backtest Lab</span>
          </NavLink>
          <NavLink to="/admin" className={({ isActive }) => `flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-emerald-500/10 text-emerald-400 font-medium' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
            <Settings className="w-5 h-5" /> <span>Administration</span>
          </NavLink>
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-4">
           <div onClick={toggleSound} className="flex items-center gap-3 text-slate-500 hover:text-white cursor-pointer transition-colors p-2 rounded-lg hover:bg-slate-800">
              {soundEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
              <span className="text-sm font-medium">Sons {soundEnabled ? 'ON' : 'OFF'}</span>
           </div>
           <div className={`flex items-center gap-3 p-2 rounded-lg border ${statusConfig.bgClass} ${statusConfig.borderClass}`}>
              <StatusIcon className={`w-4 h-4 ${statusConfig.iconColor}`} />
              <div className="flex flex-col">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-tighter">Persistence Layer</span>
                  <span className={`text-[10px] font-bold ${statusConfig.colorClass} leading-tight`}>{statusConfig.label}</span>
              </div>
           </div>
           <div className="flex items-center gap-2 text-[10px] text-slate-600 justify-center pt-2">
              <ShieldAlert className="w-3 h-3" /> <span>V18.0 TITAN ENGINE</span>
           </div>
        </div>
      </aside>

      <nav className="lg:hidden fixed bottom-0 left-0 w-full bg-slate-900 border-t border-slate-800 flex justify-around items-center px-1 py-3 z-40 pb-5 shadow-[0_-5px_20px_rgba(0,0,0,0.5)]">
          <NavLink to="/" className={({ isActive }) => `flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${isActive ? 'text-cyan-400' : 'text-slate-500'}`}><LayoutDashboard className="w-6 h-6" /><span className="text-[10px] font-medium">Dash</span></NavLink>
          <NavLink to="/scanner" className={({ isActive }) => `flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${isActive ? 'text-violet-400' : 'text-slate-500'}`}><Radar className="w-6 h-6" /><span className="text-[10px] font-medium">Radar</span></NavLink>
          <NavLink to="/backtest" className={({ isActive }) => `flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${isActive ? 'text-amber-400' : 'text-slate-500'}`}><History className="w-6 h-6" /><span className="text-[10px] font-medium">Test</span></NavLink>
          <NavLink to="/admin" className={({ isActive }) => `flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${isActive ? 'text-emerald-400' : 'text-slate-500'}`}><Settings className="w-6 h-6" /><span className="text-[10px] font-medium">Admin</span></NavLink>
      </nav>

      <main className="flex-1 lg:ml-64 p-4 lg:p-8 overflow-x-hidden mb-20 lg:mb-0">
        {children}
      </main>

      {showNotification && notificationData && (
        <div className="fixed top-6 right-6 z-50 animate-slide-in-right">
          <div className="bg-slate-900 border border-emerald-500/50 rounded-xl shadow-2xl shadow-emerald-500/10 p-4 w-80 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500" />
            <div className="flex justify-between items-start mb-2">
               <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                  <span className="font-bold text-white text-sm">SIGNAL V18</span>
               </div>
               <button onClick={() => setShowNotification(false)} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex items-center justify-between mb-3">
               <div>
                  <h3 className="text-lg font-bold text-white">{notificationData.asset}</h3>
                  <span className="text-xs text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">{notificationData.timeFrame}</span>
               </div>
               <div className={`text-lg font-bold ${notificationData.type === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`}>{notificationData.type}</div>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 bg-slate-950 p-2 rounded">
               <span>Confiance: <strong className="text-white">{notificationData.confidence}%</strong></span>
               <span>Prix: <strong className="text-white">{notificationData.priceAtSignal}</strong></span>
            </div>
            <NavLink to={`/signal/${notificationData.id}`} onClick={() => setShowNotification(false)} className="mt-3 flex items-center justify-center gap-2 w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded-lg text-xs font-bold transition-colors">
              Voir Analyse <ArrowRight className="w-3 h-3" />
            </NavLink>
          </div>
        </div>
      )}
    </div>
  );
};

export default Layout;
