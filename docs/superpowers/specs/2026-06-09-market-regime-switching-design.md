# Market Regime Switching Strategy — Design Spec
**Date:** 2026-06-09  
**Status:** Approved  
**Context:** V15 Sniper H4 walk-forward verdict ABANDON (2 fenêtres négatives consécutives OOS-5/6 sur données cTrader réelles). Diagnostic : régime mean-reversion post-Nov 2024 incompatible avec le Donchian breakout trend-following.

---

## Problème

V15 Sniper a un edge réel en régime directionnel (OOS-1/3/4 : E=+0.12 à +0.26R) mais échoue en régime range/choppy (OOS-2/5/6). Trois tentatives de fix (grid SL×R:R, filtre ATR, pullback entry) ont toutes confirmé que le problème est architectural — pas paramétrique.

---

## Solution : Market Regime Switching

Une seule logique de sélection par barre fermée :

```
ADX(14) > 25  →  TREND mode   →  V15 Sniper (Donchian breakout)
ADX(14) ≤ 25  →  RANGE mode   →  RSI + Bollinger Mean Reversion
```

---

## Architecture

### Régime TREND — V15 Sniper (existant)
Logique inchangée depuis `marketEngine.ts` / `walk-forward-ctrader-h4.ts` :
- Filtres : MTF alignment, Choppiness < 55, ADX ≥ 22 ET rising, Fan widening, RSI non-extrême
- Entrée : cassage Donchian(24) + buffer 0.15 ATR avec Triple EMA Fan
- SL : 2.0 ATR | TP : 2R | MAX_HOLD : 30 barres H4

### Régime RANGE — RSI + BB Mean Reversion (nouveau)
**Entrée BUY :**
- ADX ≤ 25 (range confirmé)
- Choppiness > 45 (marché non-directionnel)
- RSI(14) < 32 (survente)
- Prix ≤ Bollinger Lower(20, 2σ) + 0.3 ATR
- Prix > EMA200 (ne pas contre-trader la tendance long terme)

**Entrée SELL :** miroir exact (RSI > 68, prix ≥ BB Upper - 0.3 ATR, prix < EMA200)

**Gestion du trade :**
- SL : 1.5 ATR (serré — contre-tendance court terme)
- TP : BB médiane (EMA20) — cible dynamique retour à la moyenne
- MAX_HOLD : 20 barres H4 (≈ 3.3 jours)
- Pas de mécanisme breakeven (trade trop court)

### Règles de coexistence
- Une seule position ouverte par actif à la fois
- Le régime est réévalué à chaque barre fermée (entrées uniquement)
- Un trade ouvert en TREND mode se gère jusqu'à clôture naturelle même si le régime bascule
- Les deux modes utilisent les mêmes 7 actifs cTrader (EURUSD, GBPUSD, USDJPY, USDCAD, NZDUSD, GBPJPY, XAUUSD)

---

## Plan de Validation

### Étape 1 — Mean Reversion seule (H4)
Script : `scripts/validation/walk-forward-h4-mean-reversion.ts`  
Objectif : confirmer que la MR a un edge indépendant avant de la combiner.  
Succès minimum : E ≥ 0.05R, PF ≥ 1.10, ≥ 20 trades.

### Étape 2 — Regime Switching combiné (H4)
Script : `scripts/validation/walk-forward-h4-regime-switch.ts`  
Objectif : V15 (ADX>25) + MR (ADX≤25) sur les mêmes 6 fenêtres OOS.  
Succès cible : E ≥ 0.10R, PF ≥ 1.30, WR ≥ 38%, ≤ 1 fenêtre négative consécutive.

### Étape 3 — Daily cTrader
Scripts : `fetch-ctrader-daily.ts` + `walk-forward-daily-regime-switch.ts`  
Objectif : comparer H4 vs Daily — le Daily est moins bruité, potentiellement plus stable.  
Données : même 7 actifs, 5 ans.

### Étape 4 — Verdict final
Comparer les 3 configurations (MR seule H4, Regime Switch H4, Regime Switch Daily).  
Adopter la meilleure pour présentation CEO.

---

## Métriques de Succès (Walk-forward)
| Métrique | Seuil minimum | Seuil cible |
|----------|---------------|-------------|
| E(R) agrégé | ≥ 0.05R | ≥ 0.10R |
| Profit Factor | ≥ 1.10 | ≥ 1.30 |
| Win Rate | ≥ 35% | ≥ 40% |
| Fenêtres négatives consécutives | ≤ 2 | ≤ 1 |
| Trades totaux | ≥ 50 | ≥ 80 |
| Max Drawdown | — | ≤ 10R |

---

## Fichiers à Créer
```
scripts/validation/
  walk-forward-h4-mean-reversion.ts    # Étape 1
  walk-forward-h4-regime-switch.ts     # Étape 2
  fetch-ctrader-daily.ts               # Étape 3a
  walk-forward-daily-regime-switch.ts  # Étape 3b
```

## Fichiers Existants Réutilisés
```
services/marketEngine.ts              # calculateIndicators + analyzeMarket
scripts/validation/data/*_4h_ctrader.json  # données H4 déjà fetchées
```

---

## Risques
1. **Mean reversion seule sans edge** → si l'étape 1 échoue, réévaluer les seuils RSI/BB
2. **Trop peu de trades en RANGE mode** → ADX ≤ 25 est moins fréquent sur les 5 ans
3. **Daily insuffisant** → cTrader limite les données à 5 ans (déjà maxed)
