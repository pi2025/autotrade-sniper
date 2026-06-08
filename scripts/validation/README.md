# scripts/validation — Harnais de validation de la stratégie

Scripts jetables, complètement découplés de l'application de production.
Objectif : déterminer si la stratégie 7-filtres a un edge réel après coûts/slippage.

**Ces scripts ne modifient jamais server.ts, marketEngine.ts ni aucun fichier de l'app.**
**`CTRADER_LIVE` reste à `false` pendant toute la durée de cette validation.**

## Étapes

| Script | Étape | Statut |
|---|---|---|
| `fetch-historical.ts` | B1 — Récupérer 6 mois de bougies M15 | ✅ Prêt |
| `run-indicators.ts` | B2 — Calculer les indicateurs sur l'historique | ⏳ Après validation B1 |
| `walk-forward.ts` | B3 — Harnais walk-forward + out-of-sample | ⏳ Après validation B2 |

## Usage

```bash
# Étape B1 : récupérer les données (durée : ~5 min)
npx tsx scripts/validation/fetch-historical.ts

# Les données sont sauvegardées dans scripts/validation/data/ (gitignored)
```

## Seuils d'interprétation (B1)

- ✅ ≥ 5 000 barres par actif ≈ 6 mois de M15 — suffisant pour walk-forward
- ⚠️  2 000–5 000 barres ≈ 2–4 mois — marginal
- ❌ < 2 000 barres — insuffisant pour conclure

## Critères d'arrêt (à définir avec le CEO avant B3)

Avant de lancer le walk-forward, définir par écrit :
- Quel expectancy minimum pour "edge confirmé" (ex : > 0.1R/trade sur 3+ fenêtres)
- Quel résultat déclenche l'abandon de la stratégie actuelle
- Qui valide le rapport final avant toute modification de marketEngine.ts
