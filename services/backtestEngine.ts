import { BacktestResult, MarketData, SignalType, StrategyParams } from '../types';
import { calculateIndicators, analyzeMarket } from './marketEngine';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const backtestAsset = (data: MarketData, strategy: StrategyParams): { trades: number[], durations: number[] } => {
  const trades: number[] = [];
  const durations: number[] = [];
  const { history, highs, lows, opens, volumes } = data;
  
  if (history.length < 800) return { trades: [], durations: [] };

  let i = 200;
  while (i < history.length - 20) {
    const entryInd = calculateIndicators(history.slice(0, i + 1), highs.slice(0, i + 1), lows.slice(0, i + 1), opens.slice(0, i + 1), (volumes || []).slice(0, i + 1), strategy);
    
    if (!entryInd) {
      i++;
      continue;
    }

    const { signal } = analyzeMarket(data.symbol, history[i], entryInd, strategy);

    if (signal && signal.winProbability >= 50) {
      const { entryPrice, stopLoss: initialSL } = signal.tradeSetup;
      const { type } = signal;
      const initialRisk = Math.abs(entryPrice - initialSL);

      if (initialRisk === 0) {
        i++;
        continue;
      }

      let currentSL = initialSL;
      let isBreakevenSet = false;
      let highestHighSinceEntry = entryPrice;
      let lowestLowSinceEntry = entryPrice;
      let tradeOpen = true;
      let exitCandle = 0;

      for (let j = i + 1; j < history.length; j++) {
        const high = highs[j];
        const low = lows[j];
        const close = history[j];
        
        if (high > highestHighSinceEntry) highestHighSinceEntry = high;
        if (low < lowestLowSinceEntry) lowestLowSinceEntry = low;
        
        let exitPrice = 0;
        
        if ((j - i) >= strategy.maxHoldPeriod) {
            exitPrice = close;
            tradeOpen = false;
        }

        if (tradeOpen) {
            if (type === SignalType.BUY) {
                if (low <= currentSL) { exitPrice = currentSL; tradeOpen = false; }
                if (!isBreakevenSet && (high - entryPrice) >= (initialRisk * strategy.breakevenTriggerR)) { currentSL = entryPrice; isBreakevenSet = true; }
                const potentialNewSL = highestHighSinceEntry - (entryInd.atr * strategy.stopLossAtrMultiplier);
                if (potentialNewSL > currentSL) currentSL = potentialNewSL;
            } else {
                if (high >= currentSL) { exitPrice = currentSL; tradeOpen = false; }
                if (!isBreakevenSet && (entryPrice - low) >= (initialRisk * strategy.breakevenTriggerR)) { currentSL = entryPrice; isBreakevenSet = true; }
                const potentialNewSL = lowestLowSinceEntry + (entryInd.atr * strategy.stopLossAtrMultiplier);
                if (potentialNewSL < currentSL) currentSL = potentialNewSL;
            }
        }
        
        if (tradeOpen && strategy.exitLogic !== 'ATR_TRAIL') {
          // Calcul léger inline au lieu de recalculer TOUS les indicateurs (O(n) → O(1))
          if (strategy.exitLogic === 'ADX_FALL') {
            // ADX approximé via variation directionnelle récente (14 bougies)
            if (j >= 28) {
              const adxWindow = 14;
              let trSum = 0, dpSum = 0, dmSum = 0;
              for (let k = j - adxWindow + 1; k <= j; k++) {
                trSum += Math.max(highs[k] - lows[k], Math.abs(highs[k] - history[k - 1]), Math.abs(lows[k] - history[k - 1]));
                const up = highs[k] - highs[k - 1], down = lows[k - 1] - lows[k];
                dpSum += (up > down && up > 0) ? up : 0;
                dmSum += (down > up && down > 0) ? down : 0;
              }
              const sTR = trSum / adxWindow;
              const dP = sTR > 0 ? (dpSum / adxWindow / sTR) * 100 : 0;
              const dM = sTR > 0 ? (dmSum / adxWindow / sTR) * 100 : 0;
              const dx = (dP + dM) > 0 ? (Math.abs(dP - dM) / (dP + dM)) * 100 : 0;
              if (dx < entryInd.adx * 0.7) { exitPrice = close; tradeOpen = false; }
            }
          }
          if (tradeOpen && strategy.exitLogic === 'EMA_20_TOUCH') {
            // EMA-20 approximée via SMA-20 sur les 20 dernières bougies
            if (j >= 20) {
              let sum20 = 0;
              for (let k = j - 19; k <= j; k++) sum20 += history[k];
              const ema20Approx = sum20 / 20;
              if (type === SignalType.BUY && low <= ema20Approx) { exitPrice = ema20Approx; tradeOpen = false; }
              if (type === SignalType.SELL && high >= ema20Approx) { exitPrice = ema20Approx; tradeOpen = false; }
            }
          }
        }

        if (!tradeOpen) {
          const pnl = (type === SignalType.BUY ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) / initialRisk;
          trades.push(pnl - 0.05);
          durations.push(j - i);
          exitCandle = j;
          break;
        }
      }

      if (tradeOpen) {
        const finalPrice = history[history.length - 1];
        const pnl = (type === SignalType.BUY ? (finalPrice - entryPrice) : (entryPrice - finalPrice)) / initialRisk;
        trades.push(pnl);
        durations.push(history.length - 1 - i);
        i = history.length;
      } else {
        i = exitCandle;
      }
      continue;
    }
    i++;
  }
  return { trades, durations };
};

export const runStrategyTournament = async (
  allMarketData: Record<string, MarketData>, 
  strategies: StrategyParams[],
  onProgress: (percent: number) => void
): Promise<BacktestResult[]> => {
  const results: BacktestResult[] = [];
  const assets = Object.values(allMarketData);
  const totalAssets = assets.length;

  if (totalAssets === 0) {
    onProgress(100);
    return strategies.map(strategy => ({
      strategyId: strategy.id, totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      netPnl: 0, profitFactor: 0, maxDrawdown: 0, avgWin: 0, avgLoss: 0,
      period: 'Pas de données historiques disponibles',
      equityCurve: [{ tradeNum: 0, equity: 0 }],
      avgTradeDuration: 0
    }));
  }

  for (const strategy of strategies) {
    let allTrades: number[] = [];
    let allDurations: number[] = [];
    let completedAssets = 0;

    for (const data of assets) {
      if (data && data.history && data.history.length > 0) {
        const { trades, durations } = backtestAsset(data, strategy);
        allTrades = [...allTrades, ...trades];
        allDurations = [...allDurations, ...durations];
      }
      completedAssets++;
      onProgress(Math.round((completedAssets / totalAssets) * 100));
      await delay(10);
    }

    let currentEquity = 0, peakEquity = 0, maxDrawdown = 0, wins = 0, losses = 0, winPnl = 0, lossPnl = 0;
    const equityCurve = [{ tradeNum: 0, equity: 0 }];
    allTrades.forEach((pnl, index) => {
        if (pnl > 0.1) { wins++; winPnl += pnl; } 
        else if (pnl < -0.1) { losses++; lossPnl += Math.abs(pnl); }

        currentEquity += pnl;
        if (currentEquity > peakEquity) peakEquity = currentEquity;
        const drawdown = peakEquity - currentEquity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        equityCurve.push({ tradeNum: index + 1, equity: Number(currentEquity.toFixed(2)) });
    });

    const totalCountedTrades = wins + losses;
    const winRate = totalCountedTrades > 0 ? (wins / totalCountedTrades) * 100 : 0;
    const avgTradeDuration = allDurations.length > 0 ? allDurations.reduce((a, b) => a + b, 0) / allDurations.length : 0;
    
    results.push({
      strategyId: strategy.id, totalTrades: allTrades.length, wins, losses, winRate,
      netPnl: Number(currentEquity.toFixed(2)), profitFactor: lossPnl > 0 ? Number((winPnl / lossPnl).toFixed(2)) : 99,
      maxDrawdown: Number(maxDrawdown.toFixed(2)), avgWin: wins > 0 ? Number((winPnl / wins).toFixed(2)) : 0,
      avgLoss: losses > 0 ? Number((lossPnl / losses).toFixed(2)) : 0,
      period: `${totalAssets} actifs sur ~15 jours`,
      equityCurve,
      avgTradeDuration
    });
  }
  return results.sort((a, b) => b.netPnl - a.netPnl);
};