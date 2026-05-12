# Go-to-Market Fixes — AutoTrade Sniper V15

**Date:** 2026-05-12  
**Branch:** fix/security-audit → merge main  
**Scope:** Bug fixes + config hardening only. Algo untouched.

## Context

Small closed group (< 10 users). cTrader in demo mode at launch. Supabase already configured in prod.

## Fixes

### 1. Backslash URLs — SignalsContext.tsx
`\api\signals`, `\api\history`, `\api\scanner` use backslashes → 404 on every load.  
Fix: Replace with forward slashes `/api/signals`, `/api/history`, `/api/scanner`.

### 2. Missing Auth Headers — SignalsContext.tsx
`toggleEngine` (`/api/engine/toggle`), `setStrategy` (`/api/engine/strategy`), `clearMuted` (`/api/engine/unmute`) call `requireAuth`-protected routes without `Authorization: Bearer <VITE_APP_PASSWORD>`.  
Fix: Add `headers: { Authorization: \`Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}\` }` to each fetch call. Same pattern already used in DELETE signal and AgentCenter.

### 3. CI/CD Production Branch — deploy-netlify.yml
`production-branch: fix/security-audit` → merging to main triggers preview deploy only.  
Fix: Change to `production-branch: main`.

### 4. CTRADER_LIVE Guard — server.ts
`placeOrder` can be called even if `CTRADER_LIVE` is absent/undefined (falsy ≠ `'false'`).  
Fix: In `executeSignalById`, before calling `ctraderService.placeOrder`, check `process.env.CTRADER_LIVE === 'true'`. If not, block with explicit log and return error. Demo mode remains safe even if env var is accidentally unset.

### 5. Supabase Schema — supabase_schema.sql
File is empty. Introspect tables `signals`, `history`, `agent_config` via Supabase MCP and write DDL.  
Fix: Populate `supabase_schema.sql` with CREATE TABLE statements for disaster recovery.

### 6. Checklist Update — docs/go-to-market-checklist.md
Add verification steps for: auth headers working, schema versioned, CTRADER_LIVE guard active.

## Out of Scope
- Auth architecture (VITE_APP_PASSWORD in bundle acceptable for closed group)
- In-memory state (already persisted via Supabase on startup)
- Algo / marketEngine.ts (stable, do not touch)
- Multi-user support
