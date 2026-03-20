
import { MarketData } from '../types';

const BINANCE_MIRRORS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy?quest=',
];

export const toBinanceSymbol = (symbol: string): string => {
  let clean = symbol.toUpperCase()
    .replace('-USD', 'USDT')
    .replace('/USD', 'USDT')
    .replace('USD', 'USDT')
    .replace('-', '')
    .replace('/', '')
    .trim();
  
  if (clean === 'BTC' || clean === 'ETH' || clean === 'SOL') clean += 'USDT';
  if (clean.endsWith('USDTUSDT')) clean = clean.replace('USDTUSDT', 'USDT');
  
  return clean;
};

const formatBinanceData = (symbol: string, klines: any[]): MarketData => {
  const opens = klines.map(k => parseFloat(k[1]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const closes = klines.map(k => parseFloat(k[4]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const timestamps = klines.map(k => k[0]);

  return {
    symbol,
    price: closes[closes.length - 1],
    timestamp: timestamps[timestamps.length - 1],
    history: closes,
    highs, lows, opens, volumes,
    dataSource: 'LIVE_API'
  };
};

// Custom implementation of Promise.any to resolve TS compilation error in environments targeting older ES versions
const promiseAny = <T>(promises: Promise<T>[]): Promise<T> => {
  return new Promise((resolve, reject) => {
    let rejectionCount = 0;
    const total = promises.length;
    if (total === 0) return reject(new Error("No promises provided"));
    
    promises.forEach(p => {
      Promise.resolve(p).then(resolve).catch(() => {
        rejectionCount++;
        if (rejectionCount === total) {
          reject(new Error("All promises were rejected"));
        }
      });
    });
  });
};

/**
 * Fetch Binance Data en utilisant une course de proxys (Racing)
 * pour obtenir la réponse la plus rapide possible.
 */
export const fetchBinanceData = async (symbol: string, interval: string = '15m', limit: number = 1000): Promise<MarketData | null> => {
  const binanceSymbol = toBinanceSymbol(symbol);
  const mirror = BINANCE_MIRRORS[Math.floor(Math.random() * BINANCE_MIRRORS.length)];
  const directUrl = `${mirror}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;

  // On lance tous les proxys en même temps. Le premier qui répond gagne.
  const fetchTasks = PROXIES.map(async (proxy) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // Timeout court pour forcer la rapidité
    
    try {
      const proxyUrl = `${proxy}${encodeURIComponent(directUrl)}`;
      const response = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) return data;
      }
      throw new Error("Invalid response");
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  });

  try {
    // On attend la première réussite
    // Fix: Using custom promiseAny helper to avoid Promise.any TS error when lib version is restricted
    const firstSuccessfulData = await promiseAny(fetchTasks);
    return formatBinanceData(symbol, firstSuccessfulData);
  } catch (e) {
    console.warn(`⚠️ Binance Racing failed for ${symbol}: All proxies failed.`);
    return null;
  }
};
