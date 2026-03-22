import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    // Charge toutes les variables d'environnement du fichier .env
    const env = loadEnv(mode, __dirname, '');

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './'),
        }
      },
      define: {
        // SÉCURITÉ : injecter UNIQUEMENT les variables nécessaires côté client
        // Jamais de secrets serveur (TELEGRAM_BOT_TOKEN, CTRADER_*, API_SECRET_TOKEN)
        'process.env.API_KEY': JSON.stringify(env.API_KEY || ''),
        'process.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL || ''),
        'process.env.VITE_SUPABASE_KEY': JSON.stringify(env.VITE_SUPABASE_KEY || ''),
        'process.env.VITE_APP_PASSWORD': JSON.stringify(env.VITE_APP_PASSWORD || ''),
        'process.env.CTRADER_ACCOUNT_ID': JSON.stringify(env.CTRADER_ACCOUNT_ID || ''),
      },
      build: {
        outDir: 'dist',
        sourcemap: false,
        minify: 'esbuild',
      }
    };
});