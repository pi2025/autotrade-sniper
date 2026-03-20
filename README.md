<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# AutoTrade Systematic V11

Plateforme de Trading Algorithmique V11 avec intégration Gemini AI et Supabase.

## 🚀 Installation & Démarrage

1. **Installer les dépendances :**
   ```bash
   npm install
   ```

2. **Configuration Supabase (Base de données) :**
   Créez un projet sur [Supabase.com](https://supabase.com), allez dans l'éditeur SQL et exécutez ce script :

   ```sql
   -- 1. Table des Signaux Actifs
   create table public.signals (
     id text not null primary key,
     asset text not null,
     timeframe text not null,
     content jsonb not null,
     created_at timestamp with time zone default timezone('utc'::text, now()) not null
   );

   -- 2. Table de l'Historique (Signaux fermés)
   create table public.history (
     id text not null primary key,
     asset text not null,
     pnl numeric,
     closed_at timestamp with time zone,
     content jsonb not null
   );

   -- 3. Table de Configuration (Persistance des réglages)
   create table public.app_config (
     key text not null primary key,
     value jsonb not null
   );

   -- 4. Table des Logs du Scanner
   create table public.scan_logs (
     id text not null primary key,
     timestamp bigint not null,
     asset text not null,
     timeframe text not null,
     status text not null,
     message text not null,
     score numeric
   );

   -- Désactivation RLS pour le mode démo (ou configurez vos policies)
   alter table public.signals enable row level security;
   create policy "Public Access Signals" on public.signals for all using (true);
   
   alter table public.history enable row level security;
   create policy "Public Access History" on public.history for all using (true);

   alter table public.app_config enable row level security;
   create policy "Public Access Config" on public.app_config for all using (true);

   alter table public.scan_logs enable row level security;
   create policy "Public Access Logs" on public.scan_logs for all using (true);
   ```

3. **Variables d'environnement :**
   Créez un fichier `.env` à la racine du projet et ajoutez vos clés :

   ```env
   API_KEY=votre_cle_google_gemini
   VITE_SUPABASE_URL=votre_url_supabase
   VITE_SUPABASE_KEY=votre_cle_anon_publique_supabase
   ```

4. **Lancer l'application :**
   ```bash
   npm run dev
   ```

## Architecture

- **Frontend**: React 19, Vite, TailwindCSS
- **AI**: Google Gemini 2.5 Flash
- **Backend**: Supabase (PostgreSQL)
- **Engine**: Trend Following Systematic (Donchian/EMA/ATR)
- **Version**: V11.0.0