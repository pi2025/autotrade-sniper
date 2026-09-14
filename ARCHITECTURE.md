# AutoTrade Sniper — Génération de signaux XAU/USD multi-agents

Système de génération de signaux de trading automatisé (Forex/Or), architecture
multi-agents, exécuté en n8n avec alertes Telegram.

## Pipeline (version V4 active)

```
Cron (5 min, lun-ven)
  → Session & News Guard (filtre Londres/NY/Overlap, blackout NFP, gap weekend vendredi)
  → Market Data H1 → HTF Bias (EMA50/EMA200, biais BULL/BEAR/NEUTRAL)
  → Market Data M15 → Technical Analysis (EMA20/50/200, ATR, RSI14, MACD, ADX Wilder)
  → Direction Filter (élimine NO_TRADE)
  → Risk Manager (position sizing en lots, capital 500€, risque 0,5%/trade,
                   SL 1.5 ATR, TP1 2.5 ATR, TP2 4 ATR, breakeven à +1R)
  → [Agent Technique ‖ Agent Fondamental ‖ Agent Sentiment]  (parallèle)
  → Merge → Multi-Agent Scoring (pondération 35/30/25/15 + bonus session + alignement H1)
  → Approved Filter (score ≥ 65/100)
  → Déduplication (3h) → Trade Journal → Alerte Telegram
```

## Points techniques notables

- **Filtre de tendance H1** : jamais de signal contre la tendance de fond (EMA50/EMA200 H1)
- **Anti-chasse** : pas de signal si le prix s'écarte de plus de 1.8 ATR de l'EMA20
- **Blackout news** : NFP (1er vendredi du mois, 11h30–13h30 UTC), pas de nouveau signal
  vendredi après 15h UTC (risque de gap weekend)
- **Scoring multi-agent** : 3 agents indépendants (technique, fondamental, sentiment)
  évalués en parallèle puis fusionnés avec un score composite sur 100
- **Position sizing dynamique** en lots réels, avec avertissement si le lot minimum
  dépasse le risque cible

## Stack

n8n · API TwelveData (cotations) · Telegram Bot API · Supabase (journal des trades)

## État réel (données de production, table `history`, 575 trades du 23/01 au 05/08/2026)

- Win rate : 41 % (238 gagnants / 336 perdants)
- PnL cumulé : négatif sur la période observée

À présenter comme un système de génération et de scoring de signaux avec journalisation
complète — pas comme une stratégie rentable en l'état. La valeur démontrée est
l'architecture (multi-agents, gestion du risque, garde-fous), pas la performance actuelle.
