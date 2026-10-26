import { describe, expect, it } from 'vitest';
import { parseHourlyLimit, parseSafeFilter } from '../src/image-settings';

const MESSAGE = 'SOGNI_HOURLY_LIMIT must be a whole number from 1 to 1000.';
const SAFE_MESSAGE = 'SOGNI_SAFE_FILTER must be on or off.';

describe('parseHourlyLimit', () => {
  it('gives no limit when unset or blank', () => {
    expect(parseHourlyLimit(undefined)).toBeUndefined();
    expect(parseHourlyLimit('')).toBeUndefined();
    expect(parseHourlyLimit('   ')).toBeUndefined();
  });

  it('accepts whole numbers from 1 to 1000, trimmed', () => {
    expect(parseHourlyLimit('50')).toBe(50);
    expect(parseHourlyLimit(' 50 ')).toBe(50);
    expect(parseHourlyLimit('1')).toBe(1);
    expect(parseHourlyLimit('1000')).toBe(1000);
  });

  it.each(['0', '1001', 'abc', '1.5', '-5'])('rejects %s', (text) => {
    expect(() => parseHourlyLimit(text)).toThrow(MESSAGE);
  });
});

describe('parseSafeFilter', () => {
  it('is off when unset, blank or off', () => {
    expect(parseSafeFilter(undefined)).toBe(false);
    expect(parseSafeFilter('')).toBe(false);
    expect(parseSafeFilter('off')).toBe(false);
    expect(parseSafeFilter(' OFF ')).toBe(false);
  });

  it('is on for on in any case, trimmed', () => {
    expect(parseSafeFilter('on')).toBe(true);
    expect(parseSafeFilter('On')).toBe(true);
    expect(parseSafeFilter(' on ')).toBe(true);
  });

  it.each(['yes', '1', 'true'])('rejects %s', (text) => {
    expect(() => parseSafeFilter(text)).toThrow(SAFE_MESSAGE);
  });
});
