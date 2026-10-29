export type ByteRange = { start: number; end: number };

const DIGITS = /^\d+$/;

// null means "send the whole file": no header, several ranges, or a header we cannot read.
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(.*)$/.exec(header.trim());
  if (!match) return null;
  const spec = match[1]!;
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const first = spec.slice(0, dash);
  const last = spec.slice(dash + 1);
  const firstOk = DIGITS.test(first);
  const lastOk = DIGITS.test(last);
  if (!firstOk && !lastOk) return null;
  if ((first !== '' && !firstOk) || (last !== '' && !lastOk)) return null;

  if (!firstOk) {
    const n = Number(last);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (!lastOk) {
    if (start >= size) return 'unsatisfiable';
    return { start, end: size - 1 };
  }
  const end = Number(last);
  if (end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
