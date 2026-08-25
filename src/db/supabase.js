import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    'VITE_SUPABASE_URL e/ou VITE_SUPABASE_ANON_KEY não configuradas. ' +
    'Copie .env.example para .env e preencha com os dados do seu projeto Supabase.'
  );
}

export const supabase = createClient(url || '', anonKey || '', {
  auth: { persistSession: false }
});
