import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Récupération des variables d'environnement ou utilisation des identifiants fournis
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://bzrsuuynxsikczcbbycn.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cnN1dXlueHNpa2N6Y2JieWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU1MzQxNTAsImV4cCI6MjA4MTExMDE1MH0.MkkltE__1eTrRuMO2ddyqq8F8L8VxXjwEOdRZ5SnOkg';

// Vérification si les clés sont configurées
export const isConfigured = 
    SUPABASE_URL.length > 0 && 
    SUPABASE_URL !== 'https://votre-projet.supabase.co' &&
    SUPABASE_ANON_KEY.length > 0 &&
    SUPABASE_ANON_KEY !== 'votre-cle-anon-publique';

// Création du client
const clientUrl = isConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co';
const clientKey = isConfigured ? SUPABASE_ANON_KEY : 'placeholder';

export const supabase = createClient(clientUrl, clientKey);

// Helper pour vérifier la connexion au démarrage
export const checkConnection = async (): Promise<'connected' | 'missing_config' | 'error'> => {
    if (!isConfigured) return 'missing_config';

    try {
        // Tentative de ping sur la table signals
        const { error } = await supabase.from('signals').select('id', { count: 'exact', head: true });
        
        // Si l'erreur est liée à une table inexistante (404/PGRST204) ou autre
        if (error) {
            console.warn("Supabase Warning:", error.message, error.code);
            // On considère connecté même si la table est vide ou s'il y a une erreur de droits spécifique,
            // tant que le serveur répond.
            if (error.code === 'PGRST116') return 'connected'; // JSON returned no data, connection ok
            
            return 'error';
        }
        return 'connected';
    } catch (e) {
        console.error("Supabase Connection Error:", e);
        return 'error';
    }
};