
import { GoogleGenAI, Chat } from "@google/genai";
import { Signal } from '../types';

/**
 * Récupère une nouvelle instance de l'IA avec la clé la plus récente.
 */
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const generateSignalExplanation = async (signal: Signal): Promise<{text: string, sources: any[]}> => {
  const ai = getAI();
  const modelName = 'gemini-2.5-flash'; // Plus rapide et économique

  // Récupération des dernières bougies pour le contexte visuel
  const lastPrices = signal.indicators.lastPrices || [];
  const priceContext = lastPrices.length > 0 
    ? `Dernières bougies (OHLC context): ${lastPrices.slice(-5).join(', ')}`
    : '';

  const prompt = `
    Tu es "Quantum Sniper V15", analyste macro et technique expert.
    Analyse ce signal : ${signal.asset} ${signal.type} à ${signal.priceAtSignal}.
    
    Données techniques :
    - ADX: ${signal.indicators.adx.toFixed(1)} (${signal.indicators.adxSlope})
    - RSI: ${signal.indicators.rsi.toFixed(1)}
    - Choppiness: ${signal.indicators.choppiness.toFixed(1)}
    - Tendance H4: ${signal.indicators.mtfAlignment?.h4}
    ${priceContext}
    
    Structure ta réponse :
    1. CONTEXTE : Pourquoi ce signal est techniquement valide ou risqué ?
    2. MACRO : Y a-t-il des news majeures ou un sentiment de marché qui contredit ce signal ?
    3. RISQUE : Quel est le danger majeur aujourd'hui sur cet actif ?
    4. VERDICT : Ton niveau de confiance (1 à 10) et recommandation de gestion.
  `;

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
      title: chunk.web?.title || "Source",
      uri: chunk.web?.uri || "#"
    })) || [];

    return {
      text: response.text || "Analyse générée.",
      sources: sources
    };
  } catch (error: any) {
    console.warn("AI Primary Call Failed (Search Tool):", error.message);
    
    // Si l'erreur est une 403 (Permission Denied pour Search), on retente SANS l'outil
    if (error.message?.includes("403") || error.message?.toLowerCase().includes("permission")) {
      try {
        const fallbackResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash', // Modèle plus léger pour le fallback
          contents: prompt + "\n\nNote: Analyse effectuée sans recherche web temps-réel (Accès Search 403).",
        });
        return { 
          text: fallbackResponse.text + "\n\n⚠️ Note: L'analyse web (Google Search) nécessite une clé API liée à un projet avec facturation active.", 
          sources: [] 
        };
      } catch (fallbackError: any) {
        return { text: `Erreur IA critique : ${fallbackError.message}`, sources: [] };
      }
    }
    
    return { text: `Erreur technique : ${error.message}`, sources: [] };
  }
};

export const createAnalystChat = (signal: Signal): Chat => {
  const ai = getAI();
  return ai.chats.create({
    model: 'gemini-3-pro-preview',
    config: { 
        systemInstruction: `Tu es Quantum Sniper. Aide l'utilisateur sur le signal ${signal.asset}.`,
    },
  });
};
