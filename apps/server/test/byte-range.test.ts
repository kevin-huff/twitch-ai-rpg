import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/byte-range.js';

describe('parseByteRange', () => {
  it('reads a-b', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=5-5', 1000)).toEqual({ start: 5, end: 5 });
  });

  it('reads a- as open ended', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('reads -n as the last n bytes', () => {
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps the end and a suffix longer than the file', () => {
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('reports unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=1000-1200', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-5', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('sends the whole file when there is no header or several ranges', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('', 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-9', 1000)).toBeNull();
  });

  it('treats other units and malformed headers as the whole file', () => {
    for (const bad of [
      'items=0-5',
      'bytes=',
      'bytes=-',
      'bytes=abc',
      'bytes=5',
      'bytes=9-3',
      'bytes=+1-5',
      'bytes=1.5-3',
      'bytes=1 -3',
      'bytes=--5',
      'bytes=1-2-3',
      'bytes=a-b',
    ]) {
      expect(parseByteRange(bad, 1000), bad).toBeNull();
    }
  });
});
