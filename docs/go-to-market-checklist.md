# Go-to-Market Checklist

## Runtime

- Front public: `https://autotrade-sniper.netlify.app`
- API via front proxy: `https://autotrade-sniper.netlify.app/api/health`
- Backend Render target: `https://autotrade-sniper.onrender.com`

## Required Environment Variables

### Netlify

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_KEY`
- `VITE_APP_PASSWORD`

### Render

- `NODE_ENV=production`
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
- `CTRADER_LIVE=false` until live execution is approved

## Pre-Launch Checks

- `npm.cmd run lint`
- `npm.cmd run build`
- `GET /api/health` returns `status: ok`
- `GET /api/engine/status` returns JSON with `isRunning`, `agentMode`, and `riskLimits`
- `GET /api/signals`, `/api/history`, and `/api/scanner` return JSON, not HTML
- `VITE_APP_PASSWORD` is set in Netlify before publishing
- `API_SECRET_TOKEN` or `VITE_APP_PASSWORD` is set in Render before production traffic
- cTrader remains in semi-auto mode for first customer-facing launch unless live autonomous trading has been formally approved
- Auth headers present on all protected POST routes: `POST /api/engine/toggle`, `/api/engine/strategy`, `/api/engine/unmute` send `Authorization: Bearer <VITE_APP_PASSWORD>`
- `CTRADER_LIVE` absent or `"false"` → `/api/agent/execute/:id`, `/api/engine/mode`, `/api/agent/mode` (non-SIGNALS_ONLY), and server startup all block cTrader connections with an explicit error
- Supabase schema versioned in `supabase_schema.sql` — recreate tables from this file in case of disaster recovery
- Supabase writes working: either enable write policies in `supabase_schema.sql` (uncomment the `FOR ALL` policies) OR switch `VITE_SUPABASE_KEY` to a `service_role` key on Render — RLS blocks all INSERT/UPDATE/DELETE with anon key by default

## Launch Guardrails

- Start in `semi-auto`; validate all executions through Telegram.
- Keep `CTRADER_LIVE=false` until at least one full paper-trading cycle is reviewed.
- Keep max concurrent trades and total risk visible in Agent Control Center before every launch/demo.
- Rotate exposed or old keys before a paid/public launch.
