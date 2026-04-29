/**
 * Agent 5 : Senior Decision Maker IA
 * Prend la décision finale en synthétisant tous les agents précédents.
 * Input : résultats des 4 agents + contexte marché
 * Output : GO/NO-GO + signal final avec SL/TP/taille
 */

import Groq from 'groq-sdk';
import { ScreenerCandidate } from './screenerAgent.ts';
import { TechnicalAnalysis } from './technicalAgent.ts';
import { MacroAnalysis } from './macroAgent.ts';
import { RiskDecision } from './riskAgent.ts';

const getGroq = () => new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 10000 });

export interface FinalDecision {
  action: 'EXECUTE' | 'SKIP';
  direction: 'BUY' | 'SELL';
  confidence: number;          // 0-100
  slPrice: number;
  tpPrice: number;
  riskPercent: number;
  reasoning: string[];
  aiVerdict: string;
}

export interface PipelineInput {
  candidate: ScreenerCandidate;
  technical: TechnicalAnalysis;
  macro: MacroAnalysis;
  risk: RiskDecision;
}

export async function runDecisionAgent(input: PipelineInput): Promise<FinalDecision> {
  const { candidate, technical, macro, risk } = input;

  // Si le risk manager a rejeté, pas besoin d'appeler l'IA
  if (risk.status === 'REJECTED') {
    return {
      action: 'SKIP',
      direction: technical.direction === 'BUY' ? 'BUY' : 'SELL',
      confidence: 0,
      slPrice: technical.slPrice,
      tpPrice: technical.tpPrice,
      riskPercent: 0,
      reasoning: [`Risk Manager REJECTED: ${risk.reasons.join(', ')}`],
      aiVerdict: 'Trade rejeté par le Risk Manager',
    };
  }

  // Si la direction technique est NEUTRAL, skip
  if (technical.direction === 'NEUTRAL') {
    return {
      action: 'SKIP',
      direction: 'BUY',
      confidence: 0,
      slPrice: 0,
      tpPrice: 0,
      riskPercent: 0,
      reasoning: ['Direction technique NEUTRAL — pas de signal clair'],
      aiVerdict: 'Pas de direction technique claire',
    };
  }

  const prompt = `Tu es un trader senior avec 20 ans d'expérience. Tu diriges un comité de validation.
Voici les analyses de ton équipe pour ${candidate.asset.name} (${candidate.asset.symbol}) à ${candidate.price} :

=== AGENT 1 : SCREENER ===
Score pré-sélection: ${candidate.screenScore}/100
Raison: ${candidate.screenReason}

=== AGENT 2 : ANALYSTE TECHNIQUE ===
Score: ${technical.score}/100
Direction: ${technical.direction}
Type d'entrée: ${technical.entryType}
SL: ${technical.slPrice.toFixed(5)} | TP: ${technical.tpPrice.toFixed(5)}
R:R = ${Math.abs(candidate.price - technical.tpPrice) / Math.abs(candidate.price - technical.slPrice) > 0 ? (Math.abs(candidate.price - technical.tpPrice) / Math.abs(candidate.price - technical.slPrice)).toFixed(1) : 'N/A'}
Analyse: ${technical.reasoning}

=== AGENT 3 : ANALYSTE MACRO ===
Score: ${macro.score}/100
Biais: ${macro.bias}
Alerte: ${macro.alertLevel}
Événements: ${macro.events.join(', ') || 'Aucun'}
Analyse: ${macro.reasoning}

=== AGENT 4 : RISK MANAGER ===
Statut: ${risk.status}
Risk max: ${risk.maxRiskPercent.toFixed(2)}%
Multiplicateur taille: ${risk.positionSizeMultiplier.toFixed(2)}
Corrélation: ${risk.correlationWarning ? 'ATTENTION' : 'OK'}
Raisons: ${risk.reasons.join(', ')}

QUESTION : Faut-il exécuter ce trade ?
- Considère le ratio risque/récompense
- Considère l'alignement technique + macro
- Considère le risque global

RÉPONDS UNIQUEMENT en JSON valide (pas de markdown, pas de commentaires) :
{
  "action": "<EXECUTE|SKIP>",
  "confidence": <0-100>,
  "adjustSL": <true|false>,
  "adjustTP": <true|false>,
  "slAdjustment_atr": <multiplicateur ATR si ajustement, sinon null>,
  "tpAdjustment_atr": <multiplicateur ATR si ajustement, sinon null>,
  "riskPercent": <% du capital à risquer, entre 0.25 et 1.0>,
  "reasoning": "<verdict final en 2-3 phrases>"
}`;

  if (!process.env.GROQ_API_KEY) {
    console.warn(`⚠️ DecisionAgent: GROQ_API_KEY manquante, fallback`);
    return fallbackDecision(input);
  }

  try {
    const groq = getGroq();
    console.log(`👨‍💼 DecisionAgent: appel Groq pour ${candidate.asset.symbol}...`);
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Tu es un trader senior expert. Réponds UNIQUEMENT en JSON valide, sans markdown ni commentaires.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content?.trim() || '';
    console.log(`👨‍💼 DecisionAgent ${candidate.asset.symbol}: réponse Groq (${text.length} chars): ${text.substring(0, 150)}`);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`⚠️ DecisionAgent: réponse non-JSON pour ${candidate.asset.symbol}:`, text.substring(0, 300));
      return fallbackDecision(input);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const h1Atr = candidate.h1Indicators.atr;
    const dir = technical.direction;

    // Ajustements SL/TP si le senior le demande
    let sl = technical.slPrice;
    let tp = technical.tpPrice;

    if (parsed.adjustSL && parsed.slAdjustment_atr) {
      const slMult = Math.max(1.5, Math.min(3.5, parsed.slAdjustment_atr));
      sl = dir === 'BUY' ? candidate.price - h1Atr * slMult : candidate.price + h1Atr * slMult;
    }
    if (parsed.adjustTP && parsed.tpAdjustment_atr) {
      const tpMult = Math.max(2.0, Math.min(6.0, parsed.tpAdjustment_atr));
      tp = dir === 'BUY' ? candidate.price + h1Atr * tpMult : candidate.price - h1Atr * tpMult;
    }

    const confidence = Math.max(0, Math.min(100, parsed.confidence || 0));
    const action = parsed.action === 'EXECUTE' && confidence >= 60 ? 'EXECUTE' : 'SKIP';

    console.log(`✅ DecisionAgent ${candidate.asset.symbol}: Groq OK → ${action} conf=${confidence}`);
    return {
      action,
      direction: dir,
      confidence,
      slPrice: sl,
      tpPrice: tp,
      riskPercent: Math.max(0.25, Math.min(1.0, parsed.riskPercent || 0.5)) * risk.positionSizeMultiplier,
      reasoning: [`[Groq IA] ${parsed.reasoning || 'Décision IA'}`],
      aiVerdict: `[Groq IA] ${parsed.reasoning || 'Analyse complète du comité'}`,
    };
  } catch (err: any) {
    console.error(`❌ DecisionAgent error for ${candidate.asset.symbol}:`, err.message, err.status || '', err.error?.message || '');
    return fallbackDecision(input);
  }
}

/** Fallback si Groq échoue — décision basée sur les scores */
function fallbackDecision(input: PipelineInput): FinalDecision {
  const { candidate, technical, macro, risk } = input;
  const avgScore = (technical.score + macro.score + candidate.screenScore) / 3;
  const execute = avgScore >= 65 && technical.direction !== 'NEUTRAL' && risk.status !== 'REJECTED';

  return {
    action: execute ? 'EXECUTE' : 'SKIP',
    direction: technical.direction === 'BUY' ? 'BUY' : 'SELL',
    confidence: Math.round(avgScore),
    slPrice: technical.slPrice,
    tpPrice: technical.tpPrice,
    riskPercent: risk.maxRiskPercent * risk.positionSizeMultiplier,
    reasoning: [
      `Fallback décision: score moyen ${avgScore.toFixed(0)}/100`,
      `Tech: ${technical.score}, Macro: ${macro.score}, Screen: ${candidate.screenScore}`,
    ],
    aiVerdict: `Fallback: ${execute ? 'EXECUTE' : 'SKIP'} (score moyen: ${avgScore.toFixed(0)})`,
  };
}
