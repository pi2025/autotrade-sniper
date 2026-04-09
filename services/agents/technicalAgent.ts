/**
 * Agent 2 : Analyste Technique IA
 * Analyse approfondie d'un candidat via Groq (Llama 3.3 70B).
 * Input : indicateurs H1 + M15 + bougies récentes
 * Output : score technique + direction + SL/TP + reasoning
 */

import Groq from 'groq-sdk';
import { ScreenerCandidate } from './screenerAgent.ts';

const getGroq = () => new Groq({ apiKey: process.env.GROQ_API_KEY });

export interface TechnicalAnalysis {
  score: number;           // 0-100
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  slPrice: number;
  tpPrice: number;
  reasoning: string;
  entryType: string;       // "Donchian Breakout", "Pullback", etc.
}

export async function runTechnicalAnalysis(candidate: ScreenerCandidate): Promise<TechnicalAnalysis> {
  const { h1Indicators: h1, m15Indicators: m15, price, asset } = candidate;

  // Dernières 20 bougies H1 pour le contexte
  const last20H1 = candidate.h1Data.history.slice(-20);
  const last20Highs = candidate.h1Data.highs.slice(-20);
  const last20Lows = candidate.h1Data.lows.slice(-20);

  const prompt = `Tu es un analyste technique expert forex/crypto/indices. Analyse ces données et donne ton verdict.

ACTIF: ${asset.name} (${asset.symbol})
PRIX ACTUEL: ${price}
TYPE: ${asset.type}

=== INDICATEURS H1 (tendance principale) ===
- EMA 20: ${h1.ema20.toFixed(5)} | EMA 50: ${h1.ema50.toFixed(5)} | EMA 200: ${h1.ema200.toFixed(5)}
- Prix vs EMAs: ${price > h1.ema20 ? 'AU-DESSUS' : 'EN-DESSOUS'} EMA20, ${price > h1.ema50 ? 'AU-DESSUS' : 'EN-DESSOUS'} EMA50, ${price > h1.ema200 ? 'AU-DESSUS' : 'EN-DESSOUS'} EMA200
- ADX: ${h1.adx.toFixed(1)} (${h1.adxSlope}) — ${h1.adx > 25 ? 'Tendance forte' : h1.adx > 20 ? 'Tendance modérée' : 'Tendance faible'}
- RSI: ${h1.rsi.toFixed(1)}
- Choppiness: ${h1.choppiness.toFixed(1)} — ${h1.choppiness < 45 ? 'Très tendanciel' : h1.choppiness < 55 ? 'Tendanciel' : 'Hésitant'}
- ATR H1: ${h1.atr.toFixed(5)}
- Donchian: Upper ${h1.donchian.upper.toFixed(5)} | Lower ${h1.donchian.lower.toFixed(5)}
- Bollinger Squeeze: ${h1.bollingerBands.isSqueezing ? 'OUI (compression)' : 'NON'}
- Phase marché: ${h1.marketPhase}
${m15 ? `
=== INDICATEURS M15 (timing entrée) ===
- ADX M15: ${m15.adx.toFixed(1)} (${m15.adxSlope})
- RSI M15: ${m15.rsi.toFixed(1)}
- Donchian M15: Upper ${m15.donchian.upper.toFixed(5)} | Lower ${m15.donchian.lower.toFixed(5)}
- Prix vs Donchian M15: ${price > m15.donchian.upper ? 'BREAKOUT HAUSSIER' : price < m15.donchian.lower ? 'BREAKOUT BAISSIER' : 'DANS LE CANAL'}` : ''}

=== 20 DERNIÈRES BOUGIES H1 (close) ===
${last20H1.map((c, i) => `${i + 1}. Close: ${c.toFixed(5)} High: ${last20Highs[i].toFixed(5)} Low: ${last20Lows[i].toFixed(5)}`).join('\n')}

RÉPONDS UNIQUEMENT en JSON valide (pas de markdown, pas de commentaires) :
{
  "score": <0-100>,
  "direction": "<BUY|SELL|NEUTRAL>",
  "slDistance_atr": <multiplicateur ATR pour le SL, entre 1.5 et 3.0>,
  "tpDistance_atr": <multiplicateur ATR pour le TP, entre 2.0 et 5.0>,
  "reasoning": "<explication courte en 1-2 phrases>",
  "entryType": "<Donchian Breakout|EMA Pullback|Momentum|Squeeze Breakout|Range Break>"
}`;

  try {
    const groq = getGroq();
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const text = response.choices[0]?.message?.content?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`⚠️ TechnicalAgent: réponse non-JSON pour ${asset.symbol}:`, text.substring(0, 200));
      return fallbackAnalysis(candidate);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const direction = parsed.direction === 'BUY' ? 'BUY' : parsed.direction === 'SELL' ? 'SELL' : 'NEUTRAL';
    const slMult = Math.max(1.5, Math.min(3.0, parsed.slDistance_atr || 2.0));
    const tpMult = Math.max(2.0, Math.min(5.0, parsed.tpDistance_atr || 3.0));

    return {
      score: Math.max(0, Math.min(100, parsed.score || 50)),
      direction,
      slPrice: direction === 'BUY' ? price - h1.atr * slMult : price + h1.atr * slMult,
      tpPrice: direction === 'BUY' ? price + h1.atr * tpMult : price - h1.atr * tpMult,
      reasoning: parsed.reasoning || 'Analyse technique IA',
      entryType: parsed.entryType || 'Momentum',
    };
  } catch (err: any) {
    console.error(`❌ TechnicalAgent error for ${asset.symbol}:`, err.message);
    return fallbackAnalysis(candidate);
  }
}

/** Fallback si Groq échoue — analyse technique pure basée sur les indicateurs */
function fallbackAnalysis(candidate: ScreenerCandidate): TechnicalAnalysis {
  const { h1Indicators: h1, price } = candidate;
  const isBull = price > h1.ema20 && h1.ema20 > h1.ema50 && h1.ema50 > h1.ema200;
  const isBear = price < h1.ema20 && h1.ema20 < h1.ema50 && h1.ema50 < h1.ema200;
  const direction = isBull ? 'BUY' as const : isBear ? 'SELL' as const : 'NEUTRAL' as const;

  let score = 40;
  if (h1.adx > 25) score += 15;
  if (h1.adxSlope === 'RISING') score += 10;
  if (h1.choppiness < 50) score += 10;
  if (isBull || isBear) score += 15;

  return {
    score: Math.min(100, score),
    direction,
    slPrice: direction === 'BUY' ? price - h1.atr * 2.0 : price + h1.atr * 2.0,
    tpPrice: direction === 'BUY' ? price + h1.atr * 3.0 : price - h1.atr * 3.0,
    reasoning: `Fallback technique: ${direction} (ADX ${h1.adx.toFixed(1)}, ${h1.adxSlope})`,
    entryType: 'Momentum',
  };
}
