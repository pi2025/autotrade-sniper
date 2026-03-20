
import { MarketData } from '../types';

export const fetchYahooData = async (symbol: string, interval: string = '15m', range: string = '15d'): Promise<MarketData> => {
  try {
    const url = `/api/market/yahoo?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`;
    const response = await fetch(url);
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
    }

    const json = await response.json();
    const result = json.chart?.result?.[0];

    if (!result) {
      throw new Error("No result in Yahoo JSON");
    }

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];
    
    if (!timestamps || !quote || !quote.close) {
      throw new Error("Malformed data in Yahoo indicators");
    }

    const validIndices = timestamps.map((_: any, i: number) => i).filter((i: number) => 
      quote.close[i] != null && 
      quote.high[i] != null && 
      quote.low[i] != null && 
      quote.open[i] != null
    );
    
    if (validIndices.length < 100) {
      throw new Error("Insufficient historical points");
    }

    const history = validIndices.map((i: number) => quote.close[i]);
    const highs = validIndices.map((i: number) => quote.high[i]);
    const lows = validIndices.map((i: number) => quote.low[i]);
    const opens = validIndices.map((i: number) => quote.open[i]); 
    const volumes = quote.volume ? validIndices.map((i: number) => quote.volume[i]) : new Array(history.length).fill(0);
    
    return {
      symbol: symbol,
      price: history[history.length - 1],
      timestamp: timestamps[validIndices[validIndices.length - 1]] * 1000,
      history, highs, lows, opens, volumes,
      dataSource: 'LIVE_API'
    };

  } catch (error: any) {
    throw new Error(`SERVER PROXY FAILED for ${symbol}: ${error.message}`);
  }
};
