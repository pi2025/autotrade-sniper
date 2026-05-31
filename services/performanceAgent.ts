import { Signal, SignalType, StrategyParams, PerformanceAgentState, PerformanceStats } from '../types.ts';

const emptyStats = (): PerformanceStats => ({
  count: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  netR: 0,
  avgR: 0,
  winRate: 0,
  profitFactor: 0,
  maxDrawdownR: 0,
});

const DEFAULT_STATE: PerformanceAgentState = {
  enabled: true,
  profile: 'ADAPTIVE_PERFORMANCE',
  lookbackTrades: 100,
  minTradesToJudge: 5,
  lastUpdated: 0,
  global: emptyStats(),
  assets: {},
  blockedAssets: [],
  preferredAssets: [],
  blockedDirections: {},
  strategyBias: {
    adxBoost: 0,
    donchianBoost: 0,
    stopLossAtrBoost: 0,
    breakevenDelayR: 0,
    mode: 'NORMAL',
    reason: 'Pas encore assez de donnees pour adapter le regime.',
  },
  journal: [],
};

const round = (value: number, decimals = 2): number => Number(value.toFixed(decimals));

const getSignalPnl = (signal: Signal): number => {
  const value = Number(signal.pnl);
  return Number.isFinite(value) ? value : 0;
};

const computeStats = (signals: Signal[]): PerformanceStats => {
  if (signals.length === 0) return emptyStats();

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let netR = 0;

  for (const signal of signals) {
    const pnl = getSignalPnl(signal);
    netR += pnl;

    if (pnl > 0.1) {
      wins += 1;
      grossWin += pnl;
    } else if (pnl < -0.1) {
      losses += 1;
      grossLoss += Math.abs(pnl);
    } else {
      breakeven += 1;
    }

    equity += pnl;
    if (equity > peak) peak = equity;
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const counted = wins + losses;
  return {
    count: signals.length,
    wins,
    losses,
    breakeven,
    netR: round(netR),
    avgR: round(netR / signals.length, 3),
    winRate: counted > 0 ? round((wins / counted) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? 99 : 0,
    maxDrawdownR: round(maxDrawdownR),
  };
};

const mergeState = (raw?: Partial<PerformanceAgentState> | null): PerformanceAgentState => ({
  ...DEFAULT_STATE,
  ...(raw ?? {}),
  global: { ...DEFAULT_STATE.global, ...(raw?.global ?? {}) },
  assets: raw?.assets ?? {},
  blockedAssets: raw?.blockedAssets ?? [],
  preferredAssets: raw?.preferredAssets ?? [],
  blockedDirections: raw?.blockedDirections ?? {},
  strategyBias: { ...DEFAULT_STATE.strategyBias, ...(raw?.strategyBias ?? {}) },
  journal: raw?.journal ?? [],
});

class PerformanceAgent {
  private state: PerformanceAgentState = mergeState();
  private supabase: any = null;

  async init(supabaseClient: any, history: Signal[]): Promise<void> {
    this.supabase = supabaseClient;
    if (supabaseClient) {
      try {
        const { data } = await supabaseClient
          .from('app_config')
          .select('value')
          .eq('key', 'performance_agent_state')
          .maybeSingle();
        this.state = mergeState(data?.value);
      } catch {
        this.state = mergeState();
      }
    }
    await this.learn(history);
  }

  getState(): PerformanceAgentState {
    return {
      ...this.state,
      global: { ...this.state.global },
      assets: { ...this.state.assets },
      blockedAssets: [...this.state.blockedAssets],
      preferredAssets: [...this.state.preferredAssets],
      blockedDirections: { ...this.state.blockedDirections },
      strategyBias: { ...this.state.strategyBias },
      journal: [...this.state.journal],
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.state = { ...this.state, enabled, lastUpdated: Date.now() };
    await this.persist();
  }

  async learn(history: Signal[]): Promise<PerformanceAgentState> {
    const closed = [...history]
      .filter((signal) => typeof signal.pnl === 'number')
      .sort((a, b) => (b.closedAt ?? b.timestamp ?? 0) - (a.closedAt ?? a.timestamp ?? 0))
      .slice(0, this.state.lookbackTrades);

    const global = computeStats([...closed].reverse());
    const byAsset = new Map<string, Signal[]>();
    const byDirection = new Map<string, Signal[]>();

    for (const signal of closed) {
      if (!signal.asset) continue;
      byAsset.set(signal.asset, [...(byAsset.get(signal.asset) ?? []), signal]);
      byDirection.set(`${signal.asset}:${signal.type}`, [...(byDirection.get(`${signal.asset}:${signal.type}`) ?? []), signal]);
    }

    const assets: PerformanceAgentState['assets'] = {};
    const blockedAssets: string[] = [];
    const preferredAssets: string[] = [];
    const blockedDirections: Record<string, string> = {};
    const journal: string[] = [];

    for (const [asset, signals] of byAsset) {
      const stats = computeStats([...signals].reverse());
      let status: PerformanceAgentState['assets'][string]['status'] = 'ALLOWED';
      let riskMultiplier = 1;
      let reason = 'Edge neutre: actif autorise.';

      if (stats.count >= this.state.minTradesToJudge && (stats.netR <= -2.5 || stats.avgR <= -0.25 || stats.profitFactor < 0.8)) {
        status = 'BLOCKED';
        riskMultiplier = 0;
        reason = `Bloque: ${stats.netR}R sur ${stats.count} trades, PF ${stats.profitFactor}.`;
        blockedAssets.push(asset);
        journal.push(`${asset} bloque par performance negative (${stats.netR}R).`);
      } else if (stats.count >= 3 && (stats.netR <= -1.2 || stats.avgR < -0.15)) {
        status = 'REDUCED';
        riskMultiplier = 0.5;
        reason = `Risque reduit: ${stats.netR}R sur ${stats.count} trades.`;
      } else if (stats.count >= 3 && stats.netR >= 1.5 && stats.avgR > 0.15 && stats.profitFactor >= 1.2) {
        status = 'PREFERRED';
        riskMultiplier = 1.15;
        reason = `Actif favori: ${stats.netR}R, PF ${stats.profitFactor}.`;
        preferredAssets.push(asset);
      }

      assets[asset] = { asset, ...stats, status, reason, riskMultiplier };
    }

    for (const [key, signals] of byDirection) {
      const stats = computeStats([...signals].reverse());
      if (stats.count >= 4 && (stats.netR <= -2 || stats.profitFactor < 0.75)) {
        blockedDirections[key] = `Direction bloquee: ${stats.netR}R sur ${stats.count} trades, PF ${stats.profitFactor}.`;
      }
    }

    const strategyBias = this.computeStrategyBias(global);

    this.state = {
      ...this.state,
      lastUpdated: Date.now(),
      global,
      assets,
      blockedAssets,
      preferredAssets,
      blockedDirections,
      strategyBias,
      journal: [...journal, strategyBias.reason].filter(Boolean).slice(0, 20),
    };

    await this.persist();
    return this.getState();
  }

  shouldScanAsset(asset: string, hasOpenSignal: boolean): { allowed: boolean; reason?: string } {
    if (!this.state.enabled || hasOpenSignal) return { allowed: true };
    if (this.state.blockedAssets.includes(asset)) {
      return { allowed: false, reason: this.state.assets[asset]?.reason ?? 'Actif bloque par agent performance.' };
    }
    return { allowed: true };
  }

  assessSignal(signal: Signal): { allowed: boolean; reason: string; riskMultiplier: number } {
    if (!this.state.enabled) return { allowed: true, reason: 'Agent performance desactive.', riskMultiplier: 1 };

    const assetDecision = this.state.assets[signal.asset];
    if (this.state.blockedAssets.includes(signal.asset)) {
      return { allowed: false, reason: assetDecision?.reason ?? 'Actif bloque par performance recente.', riskMultiplier: 0 };
    }

    const directionKey = `${signal.asset}:${signal.type}`;
    if (this.state.blockedDirections[directionKey]) {
      return { allowed: false, reason: this.state.blockedDirections[directionKey], riskMultiplier: 0 };
    }

    return {
      allowed: true,
      reason: assetDecision?.reason ?? 'Signal autorise par agent performance.',
      riskMultiplier: assetDecision?.riskMultiplier ?? 1,
    };
  }

  adaptStrategy(base: StrategyParams): StrategyParams {
    if (!this.state.enabled) return base;
    const { strategyBias } = this.state;
    return {
      ...base,
      id: `${base.id}_${strategyBias.mode.toLowerCase()}`,
      name: `${base.name} + Agent ${strategyBias.mode}`,
      adxThreshold: Math.min(42, base.adxThreshold + strategyBias.adxBoost),
      donchianPeriod: Math.min(70, base.donchianPeriod + strategyBias.donchianBoost),
      stopLossAtrMultiplier: Math.min(3.4, round(base.stopLossAtrMultiplier + strategyBias.stopLossAtrBoost, 1)),
      breakevenTriggerR: Math.min(1.6, round(base.breakevenTriggerR + strategyBias.breakevenDelayR, 1)),
    };
  }

  private computeStrategyBias(global: PerformanceStats): PerformanceAgentState['strategyBias'] {
    if (global.count < 20) {
      return {
        adxBoost: 0,
        donchianBoost: 0,
        stopLossAtrBoost: 0,
        breakevenDelayR: 0,
        mode: 'NORMAL',
        reason: 'Apprentissage en observation: moins de 20 trades clotures.',
      };
    }

    if (global.netR <= -6 || global.maxDrawdownR >= 12 || global.profitFactor < 0.9) {
      return {
        adxBoost: 5,
        donchianBoost: 12,
        stopLossAtrBoost: 0.4,
        breakevenDelayR: 0.2,
        mode: 'RECOVERY',
        reason: `Regime recovery: net ${global.netR}R, DD ${global.maxDrawdownR}R, PF ${global.profitFactor}. Filtres durcis.`,
      };
    }

    if (global.netR < 0 || global.profitFactor < 1.1) {
      return {
        adxBoost: 3,
        donchianBoost: 6,
        stopLossAtrBoost: 0.2,
        breakevenDelayR: 0.1,
        mode: 'STRICT',
        reason: `Regime strict: edge insuffisant (${global.netR}R, PF ${global.profitFactor}).`,
      };
    }

    return {
      adxBoost: 0,
      donchianBoost: 0,
      stopLossAtrBoost: 0,
      breakevenDelayR: 0,
      mode: 'NORMAL',
      reason: `Regime normal: edge positif (${global.netR}R, PF ${global.profitFactor}).`,
    };
  }

  private async persist(): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.supabase
        .from('app_config')
        .upsert({ key: 'performance_agent_state', value: this.state }, { onConflict: 'key' });
    } catch (e) {
      console.warn('PerformanceAgent: persistence echouee', e);
    }
  }
}

export const performanceAgent = new PerformanceAgent();
