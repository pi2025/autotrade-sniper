import { Signal, AgentMode, AgentLimits, AgentPositionSizing } from '../types.ts';

export interface ExecutionDecision {
  execute: boolean;
  mode: AgentMode;
  reason?: string;
}

export const DEFAULT_POSITION_SIZING: AgentPositionSizing = {
  mode: 'RISK_PERCENT',
  riskPercent: 1,
  fixedAmount: 10,
  fixedLot: 0.01,
  multiplier: 1,
  forexMultiplier: 1,
  cryptoMultiplier: 0.25,
  commodityMultiplier: 0.25,
  indexMultiplier: 0.25,
  stockMultiplier: 0.1,
  minVolumeUnits: 1,
  maxVolumeUnits: 100000,
};

const DEFAULT_LIMITS: AgentLimits = {
  maxSimultaneousTrades: 3,
  maxRiskPercent: 5,
  maxDrawdownPercent: 15,
  positionSizing: { ...DEFAULT_POSITION_SIZING },
};

class AgentController {
  private mode: AgentMode = 'SIGNALS_ONLY';
  private limits: AgentLimits = { ...DEFAULT_LIMITS };
  private peakBalance = 0;
  private supabase: any = null;

  async init(supabaseClient: any): Promise<void> {
    this.supabase = supabaseClient;
    if (!supabaseClient) return;

    try {
      const { data } = await supabaseClient
        .from('app_config')
        .select('key, value')
        .in('key', ['agent_mode', 'agent_limits']);

      for (const row of data ?? []) {
        if (row.key === 'agent_mode') this.mode = row.value as AgentMode;
        if (row.key === 'agent_limits') this.limits = this.normalizeLimits(row.value);
      }
      console.log(`🤖 AgentController initialisé — mode: ${this.mode}`);
    } catch (e) {
      console.warn('AgentController: impossible de charger depuis Supabase, défauts utilisés.');
    }
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.mode = mode;
    await this.persist('agent_mode', mode);
    console.log(`🤖 Mode agent changé → ${mode}`);
  }

  async setLimits(limits: Partial<AgentLimits>): Promise<void> {
    this.limits = this.normalizeLimits({ ...this.limits, ...limits });
    await this.persist('agent_limits', this.limits);
  }

  getMode(): AgentMode { return this.mode; }
  getLimits(): AgentLimits { return { ...this.limits }; }
  getPositionSizing(): AgentPositionSizing { return { ...this.limits.positionSizing }; }

  shouldExecute(signal: Signal, activeSignals: Signal[]): ExecutionDecision {
    if (this.mode === 'EMERGENCY_STOP') {
      return { execute: false, mode: this.mode, reason: "Arrêt d'urgence actif" };
    }
    if (this.mode === 'SIGNALS_ONLY') {
      return { execute: false, mode: this.mode };
    }
    if (activeSignals.length >= this.limits.maxSimultaneousTrades) {
      return { execute: false, mode: this.mode, reason: `Trades simultanés max atteint (${this.limits.maxSimultaneousTrades})` };
    }
    if (this.mode === 'SEMI_AUTO') {
      return { execute: false, mode: 'SEMI_AUTO' };
    }
    // AUTONOMOUS
    return { execute: true, mode: 'AUTONOMOUS' };
  }

  async checkDrawdown(currentBalance: number): Promise<boolean> {
    if (currentBalance > this.peakBalance) this.peakBalance = currentBalance;
    if (this.peakBalance === 0) return false;

    const drawdownPct = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
    if (drawdownPct >= this.limits.maxDrawdownPercent) {
      console.error(`🚨 Drawdown max atteint: ${drawdownPct.toFixed(1)}% >= ${this.limits.maxDrawdownPercent}%`);
      await this.setMode('EMERGENCY_STOP');
      return true;
    }
    return false;
  }

  private async persist(key: string, value: any): Promise<void> {
    if (!this.supabase) return;
    try {
      await this.supabase
        .from('app_config')
        .upsert({ key, value }, { onConflict: 'key' });
    } catch (e) {
      console.warn('AgentController: persist échoué', e);
    }
  }

  private normalizeLimits(raw: Partial<AgentLimits> | null | undefined): AgentLimits {
    return {
      ...DEFAULT_LIMITS,
      ...(raw ?? {}),
      positionSizing: {
        ...DEFAULT_POSITION_SIZING,
        ...(raw?.positionSizing ?? {}),
      },
    };
  }
}

export const agentController = new AgentController();
