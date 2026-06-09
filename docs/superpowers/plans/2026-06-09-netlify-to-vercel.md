# Migration Netlify → Vercel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supprimer toutes les dépendances Netlify et activer le déploiement Vercel natif en ajoutant `vercel.json` pour le routing SPA.

**Architecture:** Trois changements fichiers uniquement — création de `vercel.json`, suppression du workflow GitHub Actions Netlify, suppression du dossier `.netlify/`. Le projet Vercel est déjà configuré (GitHub connecté, 4 env vars `VITE_*` présentes, build Vite → `dist/`).

**Tech Stack:** Vercel (SPA hosting), GitHub Actions (suppression), Vite/React

---

## File Map

| Fichier | Action | Rôle |
|---|---|---|
| `vercel.json` | Créer | Rewrite SPA — toutes les routes servent `index.html` |
| `.github/workflows/deploy-netlify.yml` | Supprimer | Workflow GitHub Actions Netlify — plus nécessaire |
| `.netlify/state.json` | Supprimer | État local Netlify |
| `.netlify/` | Supprimer (dossier) | Dossier de config Netlify |

---

## Task 1 — Créer vercel.json et supprimer les fichiers Netlify

**Files:**
- Create: `vercel.json`
- Delete: `.github/workflows/deploy-netlify.yml`
- Delete: `.netlify/state.json` (et le dossier `.netlify/`)

- [ ] **Step 1 : Vérifier que les fichiers cibles existent**

```bash
ls .github/workflows/deploy-netlify.yml
ls .netlify/state.json
ls .vercel/project.json
```

Sortie attendue : les 3 fichiers présents. Si `.vercel/project.json` est absent → STOP, le projet Vercel n'est pas lié, revoir la configuration Vercel dashboard.

- [ ] **Step 2 : Créer `vercel.json`**

Créer le fichier `vercel.json` à la racine du repo avec ce contenu exact :

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

- [ ] **Step 3 : Vérifier que `vercel.json` est valide JSON**

```bash
npx --yes ajv-cli validate -s /dev/null vercel.json 2>/dev/null || node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('JSON valide')"
```

Sortie attendue : `JSON valide`. Si erreur de parsing → vérifier qu'il n'y a pas de virgule ou guillemet manquant.

- [ ] **Step 4 : Supprimer le workflow Netlify**

```bash
git rm .github/workflows/deploy-netlify.yml
```

Sortie attendue :
```
rm '.github/workflows/deploy-netlify.yml'
```

- [ ] **Step 5 : Supprimer le dossier .netlify/**

```bash
git rm -r .netlify/
```

Sortie attendue :
```
rm '.netlify/state.json'
```

- [ ] **Step 6 : Vérifier le git status**

```bash
git status
```

Sortie attendue :
```
Changes to be committed:
  deleted:    .github/workflows/deploy-netlify.yml
  deleted:    .netlify/state.json

Untracked files:
  vercel.json
```

- [ ] **Step 7 : Stager vercel.json et committer**

```bash
git add vercel.json
git commit -m "feat: migration Netlify → Vercel (vercel.json SPA routing, suppression workflow Netlify)"
```

Sortie attendue :
```
[main xxxxxxx] feat: migration Netlify → Vercel (vercel.json SPA routing, suppression workflow Netlify)
 3 files changed, 3 insertions(+), 56 deletions(-)
```

---

## Task 2 — Pousser et vérifier le déploiement Vercel

**Files:** aucun (vérification uniquement)

- [ ] **Step 1 : Pusher sur main**

```bash
git push origin main
```

Sortie attendue :
```
To https://github.com/pi2025/autotrade-sniper.git
   xxxxxxx..xxxxxxx  main -> main
```

- [ ] **Step 2 : Confirmer le déploiement dans le dashboard Vercel**

Aller sur **vercel.com** → projet `autotrade-sniper` → onglet **Deployments**. Un nouveau déploiement doit apparaître avec le statut **"Building"** puis **"Ready"** dans les 2 minutes.

Si le déploiement échoue avec une erreur de build :
- Vérifier que les 4 env vars `VITE_*` sont bien présentes dans Vercel → Settings → Environment Variables
- Vérifier que le Framework Preset est `Vite` et l'Output Directory est `dist`

- [ ] **Step 3 : Vérifier le routing SPA**

Une fois le déploiement en **"Ready"** :
1. Ouvrir l'URL Vercel du projet (ex: `https://autotrade-sniper.vercel.app`)
2. Naviguer vers une route de l'app (ex: `/`)
3. Faire un **refresh complet (F5)** sur cette page

Résultat attendu : la page se charge correctement (pas de 404). Si 404 → vérifier que `vercel.json` est bien à la racine du repo et contient la règle `rewrites`.

- [ ] **Step 4 : Confirmer que Netlify ne se déclenche plus**

Aller sur **GitHub** → repo `pi2025/autotrade-sniper` → onglet **Actions**. Les workflows récents ne doivent montrer **aucun job "Deploy Frontend to Netlify"** pour ce dernier push. Seuls les jobs Vercel (s'il y en a) ou aucun job doivent apparaître.

---

## Checklist finale (critères de "terminé" de la spec)

- [ ] `vercel.json` présent à la racine du repo
- [ ] `.github/workflows/deploy-netlify.yml` supprimé du repo
- [ ] `.netlify/` supprimé du repo
- [ ] Déploiement Vercel visible et en "Ready" dans le dashboard
- [ ] Refresh sur une route frontend ne retourne pas 404
- [ ] Aucun job Netlify dans GitHub Actions pour le dernier push
