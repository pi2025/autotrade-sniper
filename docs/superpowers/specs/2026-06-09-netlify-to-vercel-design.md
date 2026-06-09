# Spec : Migration Netlify → Vercel

**Date :** 2026-06-09  
**Scope :** Supprimer toutes les dépendances Netlify, activer le déploiement Vercel natif GitHub

---

## Contexte

Le frontend React/Vite est actuellement déployé via un workflow GitHub Actions vers Netlify (`.github/workflows/deploy-netlify.yml`). Le projet Vercel `autotrade-sniper` est déjà configuré (`.vercel/project.json`) avec :
- GitHub repo connecté (déploiements visibles dans Vercel dashboard)
- 4 env vars `VITE_*` déjà présentes sur Vercel
- Build Vite → `dist/`, identique des deux côtés

## Ce qui change

### Fichiers à supprimer
- `.github/workflows/deploy-netlify.yml` — workflow GitHub Actions Netlify
- `.netlify/state.json` — état local Netlify
- `.netlify/` — dossier complet

### Fichier à créer
- `vercel.json` à la racine :

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Nécessaire pour le routing SPA React : sans cette règle, un rafraîchissement sur `/signals` ou `/backtest` retourne une 404 Vercel.

### Ce qu'on ne touche pas
- `vite.config.ts` — identique, aucun changement
- `render.yaml` / backend Render — non concerné
- GitHub Secrets — `NETLIFY_AUTH_TOKEN` peut être supprimé manuellement mais n'est pas critique (le workflow qui l'utilise sera supprimé)

## Résultat attendu

- Chaque push sur `main` → Vercel détecte automatiquement le changement → build `npm run build` → déploiement sur `autotrade-sniper.vercel.app`
- Aucun déploiement Netlify ne se déclenche (workflow supprimé)
- Routing SPA fonctionnel sur toutes les routes

## Critères de "terminé"

1. `vercel.json` présent à la racine
2. `.github/workflows/deploy-netlify.yml` supprimé
3. `.netlify/` supprimé
4. Push sur `main` → déploiement Vercel réussi visible dans le dashboard
5. Refresh sur une route frontend (ex: `/`) ne retourne pas 404
