// Shared spoken-number utilities used by the parser normalization layer and enrichment fallback.

export const WORD_NUM: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export const SPOKEN_NUM_WORDS = Object.keys(WORD_NUM)
  .filter(k => k !== 'zero')
  .join('|');

/** Converts a token to an integer if it is a digit string or a word-number; returns null otherwise. */
export function parseSpokenInt(token: unknown): number | null {
  if (typeof token === 'number') {
    return Number.isFinite(token) ? Math.round(token) : null;
  }
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
  }
  const w = WORD_NUM[t];
  return w !== undefined ? w : null;
}

/** Converts a token to a float if it is a numeric string or number; returns null otherwise. */
export function parseSpokenFloat(token: unknown): number | null {
  if (typeof token === 'number') {
    return Number.isFinite(token) ? token : null;
  }
  if (typeof token !== 'string') return null;
  const n = parseFloat(token.trim());
  return Number.isFinite(n) ? n : null;
}
