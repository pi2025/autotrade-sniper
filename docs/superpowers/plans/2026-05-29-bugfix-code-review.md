# Bugfix — Code Review Anomalies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 7 confirmed bugs surfaced by the high-effort code review.

**Architecture:** Surgical one-file-at-a-time fixes; no refactoring beyond the named defect. Each task is independent. All changes go into a single commit per task, then one deploy push at the end.

**Tech Stack:** TypeScript, React 19, Express 5, tsx (runtime), Vite (frontend build), Render (backend), Vercel (frontend).

---

## Files Modified

| File | Bug(s) fixed |
|------|-------------|
| `server.ts` | Task 1 (SEMI_AUTO crypto), Task 4 (unmute auth) |
| `services/ctraderService.ts` | Task 2 (init blocking/double socket) |
| `pages/SignalDetails.tsx` | Task 3 (ind null crash) |
| `context/SignalsContext.tsx` | Task 4 (clearMuted auth + optimistic), Task 7 |
| `pages/AgentCenter.tsx` | Task 5 (falsy-zero count), Task 6 (toggle check) |

---

## Task 1 — Fix SEMI_AUTO sending Telegram validation for crypto signals

**Files:** Modify `server.ts` lines ~377-391

**Bug:** The `else if (decision.mode === 'SEMI_AUTO')` branch fires for ALL asset types. Crypto signals get a Telegram "Valider le trade" prompt; when operator validates, `executeSignalById` blocks with "crypto non exécutable" and the signal stays in `activeSignals` forever consuming a trade slot.

- [ ] **Step 1: Edit server.ts — add CRYPTO guard to SEMI_AUTO branch**

Change line ~377 from:
```typescript
} else if (decision.mode === 'SEMI_AUTO') {
```
To:
```typescript
} else if (decision.mode === 'SEMI_AUTO' && newSignal.assetType !== AssetType.CRYPTO) {
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "fix: skip SEMI_AUTO Telegram validation for crypto signals"
```

---

## Task 2 — Fix ctraderService.init() blocking HTTP + double socket

**Files:** Modify `server.ts` lines ~619-630 (`/agent/mode` handler)

**Bug:** `await ctraderService.init()` is called inline inside the HTTP handler for POST `/agent/mode`. If cTrader is disconnecting/reconnecting, `init()` opens a second TLS socket alongside the auto-reconnect timer, AND blocks the HTTP response for 3-10 seconds until TLS + auth completes.

**Fix:** Fire-and-forget `init()` (don't await). The background monitor already manages the cTrader connection; the mode change should succeed immediately without waiting for connection.

- [ ] **Step 1: Edit server.ts — remove await from init() in /agent/mode handler**

Find the handler (around line 619). Change:
```typescript
apiRouter.post("/agent/mode", sensitiveRateLimit, requireAuth, async (req, res) => {
  const { mode } = req.body as { mode: AgentMode };
  const valid: AgentMode[] = ['SIGNALS_ONLY', 'SEMI_AUTO', 'AUTONOMOUS', 'EMERGENCY_STOP'];
  if (!valid.includes(mode) || mode === 'EMERGENCY_STOP') return res.status(400).json({ error: 'Mode invalide. Utilisez /api/agent/emergency-stop pour le stop d\'urgence.' });
  if (mode !== 'SIGNALS_ONLY' && !ctraderService.isConnected()) {
    try { await ctraderService.init(); } catch (e: any) {
      return res.status(500).json({ error: `cTrader init échoué: ${e.message}` });
    }
  }
  await agentController.setMode(mode);
  res.json({ success: true, mode });
});
```
To:
```typescript
apiRouter.post("/agent/mode", sensitiveRateLimit, requireAuth, async (req, res) => {
  const { mode } = req.body as { mode: AgentMode };
  const valid: AgentMode[] = ['SIGNALS_ONLY', 'SEMI_AUTO', 'AUTONOMOUS', 'EMERGENCY_STOP'];
  if (!valid.includes(mode) || mode === 'EMERGENCY_STOP') return res.status(400).json({ error: 'Mode invalide. Utilisez /api/agent/emergency-stop pour le stop d\'urgence.' });
  if (mode !== 'SIGNALS_ONLY' && !ctraderService.isConnected()) {
    ctraderService.init().catch((e: any) => console.error('cTrader init error:', e.message));
  }
  await agentController.setMode(mode);
  res.json({ success: true, mode });
});
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "fix: fire-and-forget ctraderService.init() in mode change — prevents HTTP block and double socket"
```

---

## Task 3 — Fix SignalDetails crash on missing indicator fields

**Files:** Modify `pages/SignalDetails.tsx` lines 71-83 and ~273-277

**Bug:** `ind.donchian.upper`, `ind.donchian.lower`, `ind.bollingerBands.upper`, `ind.bollingerBands.lower`, `ind.bollingerBands.isSqueezing`, `ind.donchian.middle` are all accessed with no optional chaining. If a signal has partial indicators (older schema, partial analysis), the component throws `TypeError` and crashes.

- [ ] **Step 1: Edit SignalDetails.tsx — add early return guard + optional chains**

Find the section starting around line 68 and update:
```typescript
  const isBuy = signal.type === SignalType.BUY;
  const currentPrice = currentMarketData.price || signal.priceAtSignal;
  const ind = signal.indicators;
  const chandelier = ind?.chandelierExit || signal.tradeSetup.stopLoss;
  const isExitTriggered = isBuy ? currentPrice <= chandelier : currentPrice >= chandelier;
```
No change needed here — `ind` can be undefined, which is fine for `chandelier`.

Find the `chartData` construction (~line 74) and wrap with guard:
```typescript
  const chartData = ind ? (currentMarketData.history || []).map((price, idx) => ({
      i: idx,
      price,
      ema200: ind.ema200,
      emaH4: ind.emaH4,
      chandelier: chandelier,
      upperDonchian: ind.donchian?.upper,
      lowerDonchian: ind.donchian?.lower,
      upperBand: ind.bollingerBands?.upper,
      lowerBand: ind.bollingerBands?.lower,
      tp: signal.tradeSetup.takeProfit,
      sl: signal.tradeSetup.stopLoss
  })).slice(-100) : [];
```

Find the ComplianceItem section (~line 273) and update:
```typescript
               <ComplianceItem label="Alignement Tendance H4" status={ind?.mtfAlignment?.isAligned} />
               <ComplianceItem label="Squeeze de Volatilité" status={ind?.bollingerBands?.isSqueezing} />
               <ComplianceItem label="Momentum ADX (>32)" status={(ind?.adx ?? 0) > 32} />
               <ComplianceItem label="Structure Donchian" status={isBuy ? currentPrice > (ind?.donchian?.middle ?? 0) : currentPrice < (ind?.donchian?.middle ?? Infinity)} />
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Commit**

```bash
git add pages/SignalDetails.tsx
git commit -m "fix: optional-chain all ind.* accesses in SignalDetails to prevent crash on partial indicators"
```

---

## Task 4 — Restore auth on /engine/unmute and fix clearMuted

**Files:** Modify `server.ts` line ~594, modify `context/SignalsContext.tsx` lines ~319-326

**Bug A:** `/engine/unmute` has no `requireAuth` — any unauthenticated client can clear all muted assets.
**Bug B:** `clearMuted` dispatches `CLEAR_MUTED` optimistically before server confirms. On failure, state appears cleared but `syncWithServer` restores server muted state silently within 10s — confusing UX with no error.

- [ ] **Step 1: Edit server.ts — add requireAuth back to /engine/unmute**

Find line ~594:
```typescript
  apiRouter.post("/engine/unmute", (req, res) => {
```
Change to:
```typescript
  apiRouter.post("/engine/unmute", requireAuth, (req, res) => {
```

- [ ] **Step 2: Edit SignalsContext.tsx — restore auth header + move dispatch after server success**

Find `clearMuted` (~line 319):
```typescript
      clearMuted: async () => {
        dispatch({ type: 'CLEAR_MUTED' });
        try {
          await fetch('/api/engine/unmute', { method: 'POST' });
        } catch (e) {
          console.error("Erreur clear muted:", e);
        }
      },
```
Replace with:
```typescript
      clearMuted: async () => {
        try {
          const res = await fetch('/api/engine/unmute', {
            method: 'POST',
            headers: { Authorization: `Bearer ${import.meta.env.VITE_APP_PASSWORD ?? ''}` },
          });
          if (res.ok) dispatch({ type: 'CLEAR_MUTED' });
        } catch (e) {
          console.error("Erreur clear muted:", e);
        }
      },
```

- [ ] **Step 3: Build**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 4: Commit**

```bash
git add server.ts context/SignalsContext.tsx
git commit -m "fix: restore requireAuth on /engine/unmute + move clearMuted dispatch after server success"
```

---

## Task 5 — Fix falsy-zero activeCount display in AgentCenter

**Files:** Modify `pages/AgentCenter.tsx` line ~153

**Bug:** `{activeCount || status.openPositions}` — when `activeCount` is `0` (no active signals), `0` is falsy and the display falls back to `status.openPositions` (always ≥ 0). The counter never shows zero.

- [ ] **Step 1: Edit AgentCenter.tsx — use nullish coalescing**

Find the line (inside the status bar section, around line 150-155):
```typescript
              &nbsp;· Signaux: <strong className="text-white">{activeCount || status.openPositions}</strong>
```
Change to:
```typescript
              &nbsp;· Signaux: <strong className="text-white">{activeCount ?? status.openPositions}</strong>
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Commit**

```bash
git add pages/AgentCenter.tsx
git commit -m "fix: use nullish coalescing for activeCount display — was treating 0 as falsy"
```

---

## Task 6 — Fix restart() not checking /engine/toggle response

**Files:** Modify `pages/AgentCenter.tsx` lines ~93-100

**Bug:** `restart()` calls `await fetch('/api/engine/toggle', ...)` but never checks `toggleRes.ok`. If the toggle fails (500, network error for a non-throwing response), mode is already SIGNALS_ONLY (restart banner gone) but engine stays stopped — no error shown, no recovery path.

- [ ] **Step 1: Edit AgentCenter.tsx — check toggle response**

Find the `restart()` function (~line 84). The inner try block currently reads:
```typescript
    try {
      const modeRes = await fetch('/api/agent/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH() },
        body: JSON.stringify({ mode: 'SIGNALS_ONLY' }),
      });
      if (!modeRes.ok) throw new Error(`Reset mode echoue (${modeRes.status})`);
      if (!engineRunning) {
        await fetch('/api/engine/toggle', {
          method: 'POST',
          headers: { Authorization: AUTH() },
        });
      }
      await fetchStatus();
    } catch (event: any) {
```
Replace with:
```typescript
    try {
      const modeRes = await fetch('/api/agent/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH() },
        body: JSON.stringify({ mode: 'SIGNALS_ONLY' }),
      });
      if (!modeRes.ok) throw new Error(`Reset mode echoue (${modeRes.status})`);
      if (!engineRunning) {
        const toggleRes = await fetch('/api/engine/toggle', {
          method: 'POST',
          headers: { Authorization: AUTH() },
        });
        if (!toggleRes.ok) throw new Error(`Demarrage moteur echoue (${toggleRes.status})`);
      }
      await fetchStatus();
    } catch (event: any) {
```

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Commit**

```bash
git add pages/AgentCenter.tsx
git commit -m "fix: check /engine/toggle response in restart() to surface half-restart failures"
```

---

## Task 7 — Deploy both apps

- [ ] **Step 1: Push all commits to GitHub (triggers Render + Vercel auto-deploy)**

```bash
git push
```

- [ ] **Step 2: Verify build passes**

```bash
npm run build 2>&1 | tail -5
```
Expected: `✓ built in N.XXs`

- [ ] **Step 3: Verify deployed version on Render**

After ~2 minutes, open browser console on the deployed app and run:
```javascript
fetch('/api/health').then(r=>r.json()).then(d=>console.log(d.version, d.routes))
```
Expected: `v16.1` and the routes array.

- [ ] **Step 4: Test mode change**

On AgentCenter, switch to SEMI-AUTO then back to SIGNAUX SEULS. Should succeed with no 404.
