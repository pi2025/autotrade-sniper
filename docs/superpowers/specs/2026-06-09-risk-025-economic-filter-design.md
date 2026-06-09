# Spec : Risk 0.25% + Filtre Économique Actif

**Date :** 2026-06-09  
**Scope :** Deux changements ciblés avant passage en demo étendu, puis live  
**CTRADER_LIVE :** reste `false` — validation en démo d'abord

---

## Contexte

Walk-forward sur 5 ans (H4, 6 fenêtres OOS, 7 actifs) : V15 Sniper H4 = meilleure config testée avec E=+0.045R agrégé, mais 3 fenêtres négatives consécutives récentes (OOS-4/5/6 = régimes macro-turbulents). Décision CEO : lancer en démo à 0.25% de risque avec filtre économique actif. Réévaluation septembre 2026.

---

## Changement 1 — Filtre Économique dans le Pipeline Agent

### Problème

`isHighImpactEventSoon()` est importé dans server.ts mais jamais appelé dans la boucle de scan. Le macroAgent demande à Groq "y a-t-il des annonces aujourd'hui ?" — Groq n'a pas de données temps-réel, réponse non fiable. Le filtre économique est donc **inactif** dans le pipeline actuel.

### Solution

Ajouter un appel à `isHighImpactEventSoon(candidate.asset.symbol, 60)` dans `server.ts`, au début de la boucle `for (const candidate of topCandidates)`, **après** les filtres blacklist/quota et **avant** le premier appel Groq (`runTechnicalAnalysis`).

### Comportement attendu

- Fenêtre : ±60 minutes autour de tout événement HIGH impact sur les devises de l'actif
- Si `isSoon=true` → `continue` avec log `ECONOMIC_BLOCK`
- Si `isSoon=false` → pipeline continue normalement
- Actifs sans mapping devise (crypto non mappé) → `isSoon=false` par défaut, non bloqués

### Fichier modifié

`server.ts` — dans la boucle `topCandidates`, ~ligne 530

### Test

Vérifier dans les logs Render qu'un actif forex avec NFP imminent apparaît comme `ECONOMIC_BLOCK` et non comme candidat Groq.

---

## Changement 2 — Risk 0.25%

### Deux endroits à modifier

**A. `services/agents/riskAgent.ts`**

```typescript
const DEFAULT_CONFIG: RiskConfig = {
  maxRiskPerTrade: 0.25,  // était 1.0
  ...
};
```

Aligne le `decision.riskPercent` affiché dans le signal avec le sizing réel.

**B. Variable d'env Render : `CTRADER_RISK_PERCENT=0.25`**

`calculateVolume()` dans ctraderService.ts lit `balance * RISK_PERCENT`. C'est la seule valeur qui compte pour le sizing réel des ordres. Doit être changée manuellement dans le dashboard Render après déploiement du code.

### Effet attendu (compte 1 000$)

| Paramètre | Avant | Après |
|---|---|---|
| Risque/trade | 1% → 10$ | 0.25% → 2.50$ |
| MaxDD V15 H4 (agrégé) | ~11.9R → ~119$ | ~11.9R → ~30$ |
| MaxDD OOS pire cas | ~15R → ~150$ | ~15R → ~37.50$ |

### Fichiers modifiés

- `services/agents/riskAgent.ts` (code)
- Render env var `CTRADER_RISK_PERCENT` (hors code, post-déploiement)

---

## Ce qui n'est PAS dans cette spec

- `CTRADER_LIVE=true` — décision séparée après validation démo
- Modification de la stratégie V15 elle-même
- Changement du seuil de confiance (`AUTONOMOUS_MIN_CONFIDENCE`)

---

## Critères de "terminé"

1. Les logs Render montrent `ECONOMIC_BLOCK` sur les actifs forex pendant une annonce HIGH impact
2. Le `riskAmount` dans les signaux affiche 0.25 (ou proche selon le multiplicateur perf)
3. `CTRADER_RISK_PERCENT=0.25` confirmé dans les env vars Render
4. Aucune régression sur les autres filtres du pipeline (blacklist, quota, R:R minimum)
