export function parseHourlyLimit(text: string | undefined): number | undefined {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return undefined;
  const limit = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || limit < 1 || limit > 1000) throw new Error('SOGNI_HOURLY_LIMIT must be a whole number from 1 to 1000.');
  return limit;
}

export function parseSafeFilter(text: string | undefined): boolean {
  const value = text?.trim().toLowerCase() ?? '';
  if (value === 'on') return true;
  if (value === '' || value === 'off') return false;
  throw new Error('SOGNI_SAFE_FILTER must be on or off.');
}
