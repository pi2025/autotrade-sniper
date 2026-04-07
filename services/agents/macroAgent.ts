/**
 * Agent 3 : Analyste Macro/Fondamental IA
 * Évalue le contexte macroéconomique via Gemini Flash + Google Search.
 * Input : actif + direction technique proposée
 * Output : score macro + biais + alertes événements
 * Coût : ~$0.001/appel (Gemini Flash gratuit)
 */

import { GoogleGenAI } from '@google/genai';
import { TechnicalAnalysis } from './technicalAgent.ts';
import { ScreenerCandidate } from './screenerAgent.ts';

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface MacroAnalysis {
  score: number;            // 0-100
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  alertLevel: 'GREEN' | 'YELLOW' | 'RED';  // RED = gros événement imminent
  events: string[];         // Événements détectés
  reasoning: string;
}

export async function runMacroAnalysis(
  candidate: ScreenerCandidate,
  technical: TechnicalAnalysis
): Promise<MacroAnalysis> {
  const ai = getAI();
  const { asset, price } = candidate;

  const prompt = `Tu es un analyste macroéconomique expert. Évalue le contexte fondamental pour ce trade.

ACTIF: ${asset.name} (${asset.symbol})
TYPE: ${asset.type}
PRIX: ${price}
DIRECTION TECHNIQUE PROPOSÉE: ${technical.direction}
TYPE D'ENTRÉE: ${technical.entryType}

Analyse les éléments suivants :
1. Y a-t-il des annonces économiques majeures aujourd'hui ou demain qui pourraient impacter cet actif ? (NFP, CPI, décision de taux, etc.)
2. Le sentiment général du marché est-il favorable à la direction proposée ?
3. Y a-t-il des risques géopolitiques ou événements majeurs à considérer ?
4. Pour les crypto : y a-t-il des événements spécifiques (halving, upgrade, hack, régulation) ?
5. Pour le forex : quelle est la politique monétaire des banques centrales concernées ?

RÉPONDS UNIQUEMENT en JSON valide (pas de markdown, pas de commentaires) :
{
  "score": <0-100, 100 = contexte macro parfait pour le trade>,
  "bias": "<BULLISH|BEARISH|NEUTRAL>",
  "alertLevel": "<GREEN|YELLOW|RED>",
  "events": ["<événement 1>", "<événement 2>"],
  "reasoning": "<explication courte en 1-2 phrases>"
}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`⚠️ MacroAgent: réponse non-JSON pour ${asset.symbol}:`, text.substring(0, 200));
      return fallbackMacro(candidate);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: Math.max(0, Math.min(100, parsed.score || 50)),
      bias: parsed.bias === 'BULLISH' ? 'BULLISH' : parsed.bias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL',
      alertLevel: parsed.alertLevel === 'RED' ? 'RED' : parsed.alertLevel === 'YELLOW' ? 'YELLOW' : 'GREEN',
      events: Array.isArray(parsed.events) ? parsed.events.slice(0, 5) : [],
      reasoning: parsed.reasoning || 'Analyse macro IA',
    };
  } catch (err: any) {
    console.error(`❌ MacroAgent error for ${asset.symbol}:`, err.message);
    return fallbackMacro(candidate);
  }
}

/** Fallback si Gemini échoue — score neutre conservateur */
function fallbackMacro(candidate: ScreenerCandidate): MacroAnalysis {
  return {
    score: 50,
    bias: 'NEUTRAL',
    alertLevel: 'YELLOW',
    events: ['Analyse macro indisponible — prudence'],
    reasoning: 'Fallback: pas de données macro, score neutre par défaut',
  };
}
