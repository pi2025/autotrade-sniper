// Base URL du serveur backend (vide en dev = même origine, URL absolue en prod)
const API_BASE = process.env.VITE_API_URL || '';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
