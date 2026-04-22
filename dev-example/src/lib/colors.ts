// Distinct preset/project colors used as defaults when none provided.
export const PRESET_COLORS = [
  '#0E6B52',
  '#0369A1',
  '#A16207',
  '#7E22CE',
  '#BE185D',
  '#1D4ED8',
  '#15803D',
  '#92400E',
  '#7C3AED',
  '#475569',
] as const;

export function colorFromString(s: string | undefined | null): string {
  if (!s) return PRESET_COLORS[0];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PRESET_COLORS[h % PRESET_COLORS.length];
}
