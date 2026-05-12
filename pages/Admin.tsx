
import React, { useState, useEffect } from 'react';
import { useSignals } from '../context/SignalsContext';
import { 
  CheckCircle, XCircle, Bot, Sliders, Save, Smartphone, BellRing, VolumeX, RefreshCw, Trash2, Cpu, Globe, Mail, Send, AlertTriangle, Activity
} from 'lucide-react';
import { STRATEGIES } from '../services/marketEngine';

interface HealthStatus {
  services?: {
    supabase?: boolean;
    telegram?: boolean;
    gemini?: boolean;
    ctrader?: boolean;
  };
}

const Admin: React.FC = () => {
  const { 
    assets, toggleAsset, activeStrategy, setStrategy, emailConfig, updateEmailConfig, resetToDefaults, mutedAssets = {}, clearMuted 
  } = useSignals();
  
  const [localEmailConfig, setLocalEmailConfig] = useState(emailConfig || { enabled: false, serviceId: '', templateId: '', publicKey: '', targetEmail: '' });
  const [n8nWebhook, setN8nWebhook] = useState(localStorage.getItem('n8n_webhook') || '');
  const [isTestingN8n, setIsTestingN8n] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('default');
  const [health, setHealth] = useState<HealthStatus | null>(null);

  // Sync local state when global state updates (important for first load)
  useEffect(() => {
    if (emailConfig) {
      setLocalEmailConfig(emailConfig);
    }
  }, [emailConfig]);

  // Filtrer les actifs réellement encore en cooldown pour l'affichage
  const activeMutedList = Object.entries(mutedAssets)
    .filter(([_, expiry]) => (expiry as number) > Date.now())
    .map(([symbol]) => symbol);

  useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
    fetch('/api/health')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  };

  const handleSaveEmail = () => {
    updateEmailConfig(localEmailConfig);
    localStorage.setItem('n8n_webhook', n8nWebhook);
    alert("Configuration sauvegardée.");
  };

  const testN8n = async () => {
    if (!n8nWebhook) return;
    setIsTestingN8n(true);
    try {
      await fetch(n8nWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'TEST_SIGNAL', asset: 'BTC/USD', type: 'LONG', price: 95000, timestamp: Date.now() })
      });
      alert("✅ Webhook envoyé !");
    } catch (e) {
      alert("❌ Erreur de connexion au Webhook");
    }
    setIsTestingN8n(false);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
      
      {/* System Status Check */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-8 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-black text-white flex items-center gap-3">
              <Activity className="w-6 h-6 text-emerald-400" />
              System Status
            </h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Vérification de la santé du serveur et des variables</p>
          </div>
        </div>
        <div className="p-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800">
            <p className="text-[10px] font-black text-slate-500 uppercase mb-2">Supabase Connection</p>
            <div className="flex items-center gap-2">
              {health?.services?.supabase ? (
                <><CheckCircle className="w-4 h-4 text-emerald-500" /> <span className="text-xs text-white font-bold">Configured</span></>
              ) : (
                <><AlertTriangle className="w-4 h-4 text-rose-500" /> <span className="text-xs text-rose-500 font-bold">Missing URL</span></>
              )}
            </div>
          </div>
          <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800">
            <p className="text-[10px] font-black text-slate-500 uppercase mb-2">Telegram Alerts</p>
            <div className="flex items-center gap-2">
              {health?.services?.telegram ? (
                <><CheckCircle className="w-4 h-4 text-emerald-500" /> <span className="text-xs text-white font-bold">Configured</span></>
              ) : (
                <><AlertTriangle className="w-4 h-4 text-amber-500" /> <span className="text-xs text-amber-500 font-bold">Not Set</span></>
              )}
            </div>
          </div>
          <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800">
            <p className="text-[10px] font-black text-slate-500 uppercase mb-2">Gemini AI</p>
            <div className="flex items-center gap-2">
              {health?.services?.gemini ? (
                <><CheckCircle className="w-4 h-4 text-emerald-500" /> <span className="text-xs text-white font-bold">Configured</span></>
              ) : (
                <><AlertTriangle className="w-4 h-4 text-rose-500" /> <span className="text-xs text-rose-500 font-bold">Missing Key</span></>
              )}
            </div>
          </div>
        </div>
        <div className="px-8 pb-8">
          <p className="text-[10px] text-slate-500 italic">
            Note: Si les variables sont manquantes, configurez-les dans le menu "Settings" de AI Studio.
          </p>
        </div>
      </section>

      {/* Blacklist Management */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-8 border-b border-slate-800 bg-rose-500/5 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-black text-white flex items-center gap-3">
              <VolumeX className="w-6 h-6 text-rose-500" />
              Muted Assets (Cooldown)
            </h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Actifs temporairement ignorés après suppression</p>
          </div>
          <button 
            onClick={() => confirm("Débloquer tous les actifs immédiatement ?") && clearMuted()}
            className="flex items-center gap-2 px-6 py-3 bg-rose-500 text-white rounded-xl font-black text-[10px] uppercase shadow-lg shadow-rose-500/20 active:scale-95 transition-all"
            disabled={activeMutedList.length === 0}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Forcer Réinitialisation
          </button>
        </div>
        <div className="p-8">
           {activeMutedList.length === 0 ? (
             <p className="text-slate-500 text-xs italic">Aucun actif dans la liste noire temporaire.</p>
           ) : (
             <div className="flex flex-wrap gap-2">
                {activeMutedList.map((asset: string) => (
                  <span key={asset} className="px-3 py-1 bg-slate-800 text-slate-300 rounded-lg text-[10px] font-black border border-slate-700 uppercase flex items-center gap-2">
                    {asset} 
                    <span className="w-1 h-1 bg-rose-500 rounded-full animate-pulse" />
                  </span>
                ))}
             </div>
           )}
        </div>
      </section>

      {/* PWA & Notifications Center */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-8 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-black text-white flex items-center gap-3">
              <Smartphone className="w-6 h-6 text-cyan-400" />
              Terminal Mobile & Push
            </h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Installation PWA et alertes natives</p>
          </div>
          <div className={`px-4 py-1.5 rounded-full text-[10px] font-black border ${
            notificationPermission === 'granted' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-800 text-slate-500 border-slate-700'
          }`}>
            STATUS: {notificationPermission.toUpperCase()}
          </div>
        </div>

        <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-8">
           <div className="space-y-4">
              <h3 className="text-sm font-bold text-slate-200">Installation Mobile</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                iOS : Partager &gt; "Sur l'écran d'accueil"<br/>
                Android : Menu (...) &gt; "Installer l'application"
              </p>
           </div>
           <div className="flex flex-col justify-center gap-3">
              <button 
                onClick={requestNotificationPermission}
                disabled={notificationPermission === 'granted'}
                className="flex items-center justify-center gap-3 px-6 py-4 rounded-2xl font-black text-xs transition-all bg-cyan-500 text-white hover:bg-cyan-400 shadow-lg"
              >
                <BellRing className="w-5 h-5" />
                ACTIVER NOTIFICATIONS PUSH
              </button>
           </div>
        </div>
      </section>

      {/* Automatisation & Pont n8n */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-8 border-b border-slate-800 bg-slate-950/50 flex justify-between items-center">
          <div>
            <h2 className="font-black text-white text-lg flex items-center gap-3">
              <Cpu className="w-6 h-6 text-violet-400" />
              Automation Pipeline (n8n / Webhook)
            </h2>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-tighter mt-1">Exportation automatique des signaux</p>
          </div>
          <button 
            onClick={handleSaveEmail}
            className="bg-cyan-600 hover:bg-cyan-500 text-white px-6 py-3 rounded-xl font-black text-xs flex items-center gap-2 transition-all shadow-lg active:scale-95"
          >
            <Save className="w-4 h-4" /> SAUVEGARDER
          </button>
        </div>

        <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-12">
          <div className="space-y-6">
            <div className="flex items-center gap-3 text-violet-400 font-black text-xs uppercase">
              <Globe className="w-4 h-4" /> Pont vers Webhook
            </div>
            <div className="space-y-3">
              <input 
                type="text" 
                value={n8nWebhook}
                onChange={(e) => setN8nWebhook(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-4 px-5 text-white text-sm font-mono focus:outline-none focus:border-violet-500 transition-all"
                placeholder="https://n8n.votre-serveur.com/webhook/..."
              />
              <button 
                onClick={testN8n}
                disabled={!n8nWebhook || isTestingN8n}
                className="w-full py-3 bg-violet-500/10 border border-violet-500/30 text-violet-400 rounded-xl font-black text-[10px] tracking-widest hover:bg-violet-500/20 transition-all flex items-center justify-center gap-2"
              >
                {isTestingN8n ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                ENVOYER UN SIGNAL TEST
              </button>
            </div>
          </div>

          <div className="space-y-6">
            <div className="flex items-center gap-3 text-emerald-400 font-black text-xs uppercase">
              <Mail className="w-4 h-4" /> Notifications Email
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
               <div>
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 block">Email Target</label>
                  <input 
                    type="text" 
                    value={localEmailConfig?.targetEmail || ''}
                    onChange={(e) => setLocalEmailConfig(prev => ({ ...prev, targetEmail: e.target.value }))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 px-4 text-white text-xs"
                  />
               </div>
            </div>
            <div className="flex items-center justify-between p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/20">
               <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest">Activer Alerte Email</span>
               <button 
                 onClick={() => setLocalEmailConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                 className={`w-12 h-6 rounded-full relative transition-colors ${localEmailConfig?.enabled ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-slate-800'}`}
               >
                 <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${localEmailConfig?.enabled ? 'left-7' : 'left-1'}`} />
               </button>
            </div>
          </div>
        </div>
      </section>

      {/* Strategy Center */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-8 border-b border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
             <h2 className="text-2xl font-black text-white flex items-center gap-3">
              <Sliders className="w-8 h-8 text-cyan-500" />
              Intelligence Center
            </h2>
            <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Configuration des Algorithmes</p>
          </div>
          <div className="flex gap-2">
            {STRATEGIES.map(s => (
               <button 
                 key={s.id}
                 onClick={() => setStrategy(s.id)}
                 className={`px-4 py-3 rounded-xl text-[10px] font-black tracking-widest uppercase border ${activeStrategy.id === s.id ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' : 'bg-slate-950 text-slate-500 border-slate-800'}`}
               >
                 {s.name}
               </button>
            ))}
          </div>
        </div>
      </section>

      {/* Assets List */}
      <section className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden flex flex-col h-[600px] shadow-xl">
        <div className="p-8 border-b border-slate-800 flex justify-between items-center bg-slate-950">
          <div>
            <h2 className="text-lg font-black text-white uppercase tracking-widest">Sélecteur d'Actifs</h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">Cochez les paires surveillées</p>
          </div>
          <button 
             onClick={() => confirm("Réinitialiser ?") && resetToDefaults()}
             className="px-4 py-2 bg-rose-500/10 text-rose-500 rounded-xl text-[10px] font-black border border-rose-500/20 hover:bg-rose-500/20"
          >
              RESET DEFAULTS
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800">
          {assets.map((asset) => (
            <div key={asset.symbol} className="flex items-center justify-between p-6 hover:bg-slate-800/30 transition-colors">
              <div className="flex items-center gap-4">
                 <div className="w-10 h-10 rounded-xl bg-slate-950 flex items-center justify-center font-black text-xs border border-slate-800 text-slate-400">{asset.symbol.substring(0,2)}</div>
                 <div>
                    <span className="font-black text-white text-lg tracking-tight">{asset.name}</span>
                    <p className="text-[10px] text-slate-500 font-mono">{asset.symbol}</p>
                 </div>
              </div>
              
              <button
                onClick={() => toggleAsset(asset.symbol)}
                className={`flex items-center gap-3 px-6 py-3 rounded-xl text-[10px] font-black transition-all border uppercase ${
                  asset.active 
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                    : 'bg-slate-950 text-slate-600 border-slate-800'
                }`}
              >
                {asset.active ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {asset.active ? 'MONITORED' : 'IGNORED'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default Admin;
