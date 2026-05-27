/**
 * tradingUtils.ts — Logique métier partagée frontend / backend
 *
 * Ce fichier est la SOURCE DE VÉRITÉ pour les règles de gestion d'exposition.
 * NE PAS dupliquer ces fonctions dans server.ts ou SignalsContext.tsx.
 */

import { AssetType, Signal, SignalType } from '../types';

export const MAX_CURRENCY_EXPOSURE = 2; // Maximum 2R d'exposition nette par devise

/**
 * Extrait la paire de devises (base / quote) depuis un symbole d'actif.
 * Couvre Forex (EURUSD=X), Crypto (BTC-USD), Commodités et Indices.
 */
export const getCurrenciesFromAsset = (
  asset: string,
  assetType: AssetType
): { base: string; quote: string } | null => {
  const specialMappings: Record<string, { base: string; quote: string }> = {
    'GC=F':  { base: 'XAU', quote: 'USD' },
    'SI=F':  { base: 'XAG', quote: 'USD' },
    'CL=F':  { base: 'WTI', quote: 'USD' },
    '^GSPC': { base: 'SPX', quote: 'USD' },
    '^IXIC': { base: 'NDX', quote: 'USD' },
    '^FCHI': { base: 'CAC', quote: 'EUR' },
  };

  if (specialMappings[asset]) return specialMappings[asset];

  if (assetType === AssetType.FOREX) {
    const clean = asset.replace('=X', '');
    if (clean.length === 6) {
      return { base: clean.substring(0, 3), quote: clean.substring(3, 6) };
    }
  }

  if (assetType === AssetType.CRYPTO) {
    const parts = asset.split('-');
    if (parts.length === 2) {
      return { base: parts[0], quote: parts[1] };
    }
  }

  return null;
};

/**
 * Vérifie si l'ajout d'un nouveau signal dépasse le seuil d'exposition
 * nette par devise sur l'ensemble des positions ouvertes.
 */
export const checkCurrencyExposure = (
  openSignals: Signal[],
  newSignal: Signal,
  threshold: number = MAX_CURRENCY_EXPOSURE
): { isAllowed: boolean; reason: string } => {
  const exposure: Record<string, number> = {};
  const allSignals = [...openSignals, newSignal];

  for (const s of allSignals) {
    const currencies = getCurrenciesFromAsset(s.asset, s.assetType);
    if (currencies) {
      const { base, quote } = currencies;
      const weight = s.type === SignalType.BUY ? 1 : -1;
      exposure[base] = (exposure[base] || 0) + weight;
      exposure[quote] = (exposure[quote] || 0) - weight;
    }
  }

  const newSignalCurrencies = getCurrenciesFromAsset(newSignal.asset, newSignal.assetType);
  if (newSignalCurrencies) {
    const { base, quote } = newSignalCurrencies;
    if (Math.abs(exposure[base] || 0) > threshold) {
      return { isAllowed: false, reason: `Exposition ${base} > ${threshold}R` };
    }
    if (Math.abs(exposure[quote] || 0) > threshold) {
      return { isAllowed: false, reason: `Exposition ${quote} > ${threshold}R` };
    }
  }

  return { isAllowed: true, reason: '' };
};
