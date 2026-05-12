import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Public client variables injected by Vite. Do not keep project credentials as fallbacks in the bundle.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_KEY || '';

export const isConfigured =
  SUPABASE_URL.length > 0 &&
  SUPABASE_URL !== 'https://votre-projet.supabase.co' &&
  SUPABASE_ANON_KEY.length > 0 &&
  SUPABASE_ANON_KEY !== 'votre-cle-anon-publique';

const clientUrl = isConfigured ? SUPABASE_URL : 'https://placeholder.supabase.co';
const clientKey = isConfigured ? SUPABASE_ANON_KEY : 'placeholder';

export const supabase: SupabaseClient = createClient(clientUrl, clientKey);

export const checkConnection = async (): Promise<'connected' | 'missing_config' | 'error'> => {
  if (!isConfigured) return 'missing_config';

  try {
    const { error } = await supabase.from('signals').select('id', { count: 'exact', head: true });

    if (error) {
      console.warn('Supabase Warning:', error.message, error.code);
      if (error.code === 'PGRST116') return 'connected';
      return 'error';
    }

    return 'connected';
  } catch (e) {
    console.error('Supabase Connection Error:', e);
    return 'error';
  }
};
