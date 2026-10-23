// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { identityPath } from './identity';

afterEach(() => window.history.replaceState({}, '', '/'));

describe('tab identity navigation', () => {
  it('preserves the selected identity through home, resume, lobby, player, director, and stage links', () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/lobby?identity=${identity}`);
    for (const path of ['/', '/sessions/show/lobby', '/sessions/show/play', '/sessions/show/director', '/sessions/show/stage']) {
      expect(identityPath(path)).toBe(`${path}?identity=${identity}`);
    }
    expect(identityPath('/sessions/show/play?testCharacterId=pc-1#seat')).toBe(`/sessions/show/play?testCharacterId=pc-1&identity=${identity}#seat`);
  });

  it('keeps old-cookie navigation available only when no selector was supplied', () => {
    window.history.replaceState({}, '', '/');
    expect(identityPath('/sessions/show/lobby')).toBe('/sessions/show/lobby');
    window.history.replaceState({}, '', '/?identity=invalid');
    expect(identityPath('/')).toBe('/?identity=invalid');
  });

  it('does not attach a selector to an external destination', () => {
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    expect(() => identityPath('https://example.com/')).toThrow('same origin');
  });
});
