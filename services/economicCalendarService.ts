
import fetch from 'node-fetch';

// --- TYPES ---
export interface EconomicEvent {
  title: string;
  currency: string;   // "USD", "EUR", "GBP", etc.
  date: Date;
  impact: 'High';
  forecast?: string;
  previous?: string;
  minutesUntil: number;
}

// --- CONFIG ---
// Forex Factory JSON (non officiel, sans clé API, fiable depuis des années)
const FF_THISWEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_NEXTWEEK  = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure — les événements ne bougent pas souvent

// --- MAPPING actif Yahoo → devises exposées ---
// Même logique que oandaService pour la cohérence
const ASSET_CURRENCIES: Record<string, string[]> = {
  'EURUSD=X': ['EUR', 'USD'],
  'GBPUSD=X': ['GBP', 'USD'],
  'USDJPY=X': ['USD', 'JPY'],
  'AUDUSD=X': ['AUD', 'USD'],
  'USDCAD=X': ['USD', 'CAD'],
  'USDCHF=X': ['USD', 'CHF'],
  'NZDUSD=X': ['NZD', 'USD'],
  'EURGBP=X': ['EUR', 'GBP'],
  'EURJPY=X': ['EUR', 'JPY'],
  'GBPJPY=X': ['GBP', 'JPY'],
  'EURAUD=X': ['EUR', 'AUD'],
  'EURCHF=X': ['EUR', 'CHF'],
  'AUDJPY=X': ['AUD', 'JPY'],
  'CHFJPY=X': ['CHF', 'JPY'],
  'EURNZD=X': ['EUR', 'NZD'],
  'GBPAUD=X': ['GBP', 'AUD'],
  'CADJPY=X': ['CAD', 'JPY'],
  'GC=F':     ['USD'],        // Or coté en USD
  'SI=F':     ['USD'],        // Argent coté en USD
  'CL=F':     ['USD'],        // Pétrole WTI en USD
  '^GSPC':    ['USD'],        // S&P 500
  '^IXIC':    ['USD'],        // NASDAQ
  '^FCHI':    ['EUR'],        // CAC 40
};

// Mots-clés HIGH impact reconnus (complète le filtre impact="High" de FF)
// Utile si d'autres sources sont ajoutées plus tard sans champ impact structuré
const HIGH_IMPACT_KEYWORDS = [
  'Non-Farm', 'NFP', 'CPI', 'Inflation', 'Interest Rate', 'Rate Decision',
  'FOMC', 'Fed ', 'Federal Reserve', 'GDP', 'Employment Change',
  'Unemployment', 'ECB', 'BOE', 'BOJ', 'RBA', 'BOC', 'SNB',
  'Monetary Policy', 'Central Bank', 'Trade Balance', 'Retail Sales',
];

// --- CACHE ---
let eventsCache: EconomicEvent[] = [];
let cacheExpiry = 0;

function isHighImpactKeyword(title: string): boolean {
  return HIGH_IMPACT_KEYWORDS.some(kw => title.includes(kw));
}

// --- FETCH & PARSE ---
async function fetchRawEvents(): Promise<EconomicEvent[]> {
  if (Date.now() < cacheExpiry && eventsCache.length > 0) {
    // Recalcule minutesUntil à chaque appel (le temps passe)
    const now = Date.now();
    return eventsCache.map(e => ({
      ...e,
      minutesUntil: Math.round((e.date.getTime() - now) / 60_000),
    }));
  }

  const results: EconomicEvent[] = [];
  const now = Date.now();

  for (const url of [FF_THISWEEK, FF_NEXTWEEK]) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (AutoTrade-Sniper/15)' },
        signal: AbortSignal.timeout(8000), // 8s timeout
      });

      if (!response.ok) {
        console.warn(`⚠️ EconomicCalendar: HTTP ${response.status} pour ${url}`);
        continue;
      }

      const raw: any[] = await response.json() as any[];

      for (const item of raw) {
        // FF retourne impact "High" | "Medium" | "Low" | "Holiday"
        if (item.impact !== 'High') continue;
        // Double-check avec keywords si jamais le champ impact est vide/absent
        if (!item.impact && !isHighImpactKeyword(item.title ?? '')) continue;

        const eventDate = new Date(item.date);
        if (isNaN(eventDate.getTime())) continue;

        results.push({
          title:       item.title ?? 'Unknown',
          currency:    (item.country ?? '').toUpperCase(),
          date:        eventDate,
          impact:      'High',
          forecast:    item.forecast ?? undefined,
          previous:    item.previous ?? undefined,
          minutesUntil: Math.round((eventDate.getTime() - now) / 60_000),
        });
      }
    } catch (err: any) {
      console.warn(`⚠️ EconomicCalendar: fetch échoué (${url}): ${err.message}`);
    }
  }

  // Tri chronologique + dédoublonnage (titre+devise+date)
  const seen = new Set<string>();
  const deduped = results
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .filter(e => {
      const key = `${e.title}|${e.currency}|${e.date.toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  eventsCache = deduped;
  cacheExpiry = Date.now() + CACHE_TTL_MS;

  console.log(`📅 EconomicCalendar: ${deduped.length} événements HIGH chargés`);
  return deduped.map(e => ({
    ...e,
    minutesUntil: Math.round((e.date.getTime() - Date.now()) / 60_000),
  }));
}

// --- API PUBLIQUE ---

/**
 * Retourne true si un événement HIGH impact est prévu dans les `windowMinutes`
 * sur l'une des devises de l'actif (passé ou futur immédiat inclus : -5 min).
 *
 * La fenêtre -5 min absorbe les événements qui viennent d'être publiés
 * et dont le marché est encore sous influence.
 */
export async function isHighImpactEventSoon(
  asset: string,
  windowMinutes: number = 60,
): Promise<{ isSoon: boolean; events: EconomicEvent[] }> {
  const currencies = ASSET_CURRENCIES[asset];
  if (!currencies?.length) return { isSoon: false, events: [] };

  let events: EconomicEvent[];
  try {
    events = await fetchRawEvents();
  } catch {
    // En cas d'échec réseau complet : on ne bloque pas le signal
    return { isSoon: false, events: [] };
  }

  const upcoming = events.filter(e =>
    currencies.includes(e.currency) &&
    e.minutesUntil >= -5 &&          // on inclut les 5 dernières minutes post-annonce
    e.minutesUntil <= windowMinutes,
  );

  return { isSoon: upcoming.length > 0, events: upcoming };
}

/**
 * Retourne tous les événements HIGH impact dans la fenêtre donnée,
 * toutes devises confondues. Utilisé pour enrichir le prompt Gemini.
 */
export async function getUpcomingHighImpactEvents(
  windowHours: number = 24,
): Promise<EconomicEvent[]> {
  let events: EconomicEvent[];
  try {
    events = await fetchRawEvents();
  } catch {
    return [];
  }

  const windowMinutes = windowHours * 60;
  return events.filter(e =>
    e.minutesUntil >= -5 &&
    e.minutesUntil <= windowMinutes,
  );
}

/**
 * Formate les événements en texte lisible pour un prompt IA.
 * Exemple : "Dans 45 min — 🇺🇸 USD — NFP (prev: 199K, fcst: 180K)"
 */
export function formatEventsForPrompt(events: EconomicEvent[]): string {
  if (!events.length) return 'Aucune annonce économique majeure dans les 24 prochaines heures.';

  return events.map(e => {
    const timeLabel = e.minutesUntil < 0
      ? `Il y a ${Math.abs(e.minutesUntil)} min`
      : e.minutesUntil < 60
        ? `Dans ${e.minutesUntil} min`
        : `Dans ${Math.round(e.minutesUntil / 60)}h`;

    const details = [
      e.previous ? `prév: ${e.previous}` : null,
      e.forecast  ? `fcst: ${e.forecast}` : null,
    ].filter(Boolean).join(', ');

    return `• ${timeLabel} — ${e.currency} — ${e.title}${details ? ` (${details})` : ''}`;
  }).join('\n');
}

/**
 * Vide le cache (utile pour les tests).
 */
export function invalidateCache(): void {
  eventsCache = [];
  cacheExpiry = 0;
}
