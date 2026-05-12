# AutoTrade Sniper V15

Plateforme de trading algorithmique avec frontend React/Vite, API Express, Supabase, alertes Telegram, analyse IA et controle d'execution cTrader.

## Demarrage local

```bash
npm install
npm run dev
```

Le script `dev` lance `server.ts`, qui sert l'API `/api/*` et le frontend Vite en developpement.

## Verification

```bash
npm.cmd run lint
npm.cmd run build
```

Sur PowerShell Windows, utilisez `npm.cmd` si l'execution de `npm.ps1` est bloquee par la policy locale.

## Variables d'environnement

Copiez `.env.example` vers `.env`, puis renseignez les valeurs necessaires:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_KEY`
- `VITE_APP_PASSWORD`
- `API_SECRET_TOKEN`
- `API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `CTRADER_CLIENT_ID`
- `CTRADER_CLIENT_SECRET`
- `CTRADER_ACCESS_TOKEN`
- `CTRADER_ACCOUNT_ID`
- `CTRADER_LIVE=false`

Voir [docs/go-to-market-checklist.md](docs/go-to-market-checklist.md) pour les controles de production.

## Deploiement

- Netlify publie `dist` et proxifie `/api/*` vers Render via `netlify.toml`.
- Render lance l'API avec `NODE_ENV=production npx tsx server.ts`.
- En production, les routes sensibles refusent les requetes si aucune variable d'authentification n'est configuree.
