// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { api, subscribeToSession } from './api';
import { streamUrl, producerUrl, readHashToken, parseStreamLocation } from './stream';

const socket = vi.hoisted(() => ({ on: vi.fn(), disconnect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('authorized session transport', () => {
  const hostIdentity = 'a'.repeat(32);
  const playerIdentity = 'b'.repeat(32);

  it('sends builder generation through the selected identity with only the current draft and revision', async () => {
    window.history.replaceState({}, '', `/build-character?identity=${playerIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'A proposed backstory' }) });
    vi.stubGlobal('fetch', fetch);
    const characterContext = { kind: 'character' as const, displayName: '', secret: 'Own private draft', possessions: ['', '', 'Map'] };
    const input = { expectedRevision: 3, field: 'character.backstory' as const, seed: '', characterContext, instructions: 'Spoofed instructions', premise: 'Other scenario', builderId: 'other' };
    expect(await api.generateCharacterBuilderField(input)).toEqual({ text: 'A proposed backstory' });
    expect(fetch.mock.calls[0][0]).toBe('/api/character-builder/generate-field');
    expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(playerIdentity);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ expectedRevision: 3, field: input.field, seed: '', characterContext });
    expect(window.location.search).toBe(`?identity=${playerIdentity}`);
  });

  it('refuses invalid builder generation context before sending a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(async () => api.generateCharacterBuilderField({ expectedRevision: 0, field: 'character.backstory', seed: '', characterContext: { kind: 'character', otherCharacter: 'Private' } } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges a builder link without forwarding an old identity or putting its token in the URL', async () => {
    window.history.replaceState({}, '', '/build-character?identity=invalid-old-selector');
    const response = { identityId: playerIdentity, builder: { id: 'own-builder' } };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetch);
    expect(await api.accessCharacterBuilder('private-token')).toEqual(response);
    expect(fetch.mock.calls[0][0]).toBe('/api/character-builder/access');
    expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'private-token' });
    expect(window.location.search).toBe('?identity=invalid-old-selector');
  });

  it('scopes builder management to the current host and escapes invitation identifiers', async () => {
    window.history.replaceState({}, '', `/library?identity=${hostIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    await api.characterBuilders();
    await api.createCharacterBuilder({ commandId: 'create', label: 'Avery', instructions: 'A desert explorer.' });
    await api.characterBuilderLink('builder/one');
    await api.revokeCharacterBuilder('builder/one', { commandId: 'revoke' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/character-builders', '/api/character-builders', '/api/character-builders/builder%2Fone/link', '/api/character-builders/builder%2Fone/revoke']);
    for (const [, init] of fetch.mock.calls) expect(init.headers['X-RPG-Identity']).toBe(hostIdentity);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ commandId: 'create', label: 'Avery', instructions: 'A desert explorer.' });
  });

  it('keeps private draft save, submission, reads and logout on the selected builder identity', async () => {
    window.history.replaceState({}, '', `/build-character?identity=${playerIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    const mutation = { commandId: 'save', expectedRevision: 3, draft: { displayName: '', secret: 'Own draft' } as never };
    await api.characterBuilder();
    await api.saveCharacterBuilder(mutation);
    await api.submitCharacterBuilder(mutation);
    await api.logoutCharacterBuilder();
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/character-builder', '/api/character-builder/save', '/api/character-builder/submit', '/api/character-builder/logout']);
    for (const [, init] of fetch.mock.calls) expect(init.headers['X-RPG-Identity']).toBe(playerIdentity);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(mutation);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual(mutation);
    expect(window.location.search).toBe(`?identity=${playerIdentity}`);
  });

  it('forwards only the requested field, brief, premise and typed same-character details', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'A draft' }) });
    vi.stubGlobal('fetch', fetch);
    const characterContext = { kind: 'character' as const, displayName: 'Aster', backstory: 'An unsaved courier history', secret: 'A forged map', possessions: ['Compass', ''] };
    const input = { field: 'character.appearance' as const, seed: '', premise: 'A harbor story', characterContext, unrelatedNotes: 'Other character private notes' };
    await api.generateField(input);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ field: input.field, seed: '', premise: input.premise, characterContext });
    characterContext.backstory = 'Changed after request';
    expect(JSON.parse(fetch.mock.calls[0][1].body).characterContext.backstory).toBe('An unsaved courier history');
  });

  it('refuses unexpected nested context fields before sending a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(async () => api.generateField({ field: 'npc.role', seed: 'A keeper', characterContext: { kind: 'npc', displayName: 'Mara', otherCharacter: 'PRIVATE' } } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps library versions and custom-show seats scoped to the selected host identity', async () => {
    window.history.replaceState({}, '', `/library?identity=${hostIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    await api.library();
    await api.starter();
    await api.saveScenario({ expectedVersion: 0, definition: { schemaVersion: 1 } as never });
    await api.saveCharacterTemplate({ templateId: 'card', expectedVersion: 2, definition: { schemaVersion: 1 } as never });
    await api.createCustom('New show', { templateId: 'scenario', version: 1 }, [{ templateId: 'card', version: 2 }, { templateId: 'card', version: 2 }]);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/library', '/api/library/starter', '/api/library/scenarios', '/api/library/characters', '/api/sessions']);
    for (const [, init] of fetch.mock.calls) expect(init.headers['X-RPG-Identity']).toBe(hostIdentity);
    expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual(expect.objectContaining({ title: 'New show', scenario: { templateId: 'scenario', version: 1 }, characters: [{ templateId: 'card', version: 2 }, { templateId: 'card', version: 2 }] }));
  });

  it('selects the current tab identity for reads, commands, and reconnects', async () => {
    window.history.replaceState({}, '', `/sessions/show/director?identity=${hostIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetch);
    await api.snapshot('show', 'director');
    await api.command('show', { type: 'publish', commandId: 'cmd-1' } as never);
    for (const [, init] of fetch.mock.calls) expect(init.headers['X-RPG-Identity']).toBe(hostIdentity);
    subscribeToSession('show', vi.fn(), vi.fn());
    expect(io).toHaveBeenCalledWith(expect.objectContaining({ auth: { sessionId: 'show', identityId: hostIdentity } }));
  });

  it('requests an independent login and changes only this tab selector after success', async () => {
    window.history.replaceState({}, '', `/sessions/show/director?identity=${hostIdentity}&view=review#notes`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'host', identityId: playerIdentity }) });
    vi.stubGlobal('fetch', fetch);
    await api.login('host-token');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'host-token', tab: true });
    expect(window.location.search).toBe(`?identity=${playerIdentity}&view=review`);
    expect(window.location.hash).toBe('#notes');
    expect(window.localStorage.length).toBe(0);
  });

  it('switches redeemed invitations without changing the selector when redemption fails', async () => {
    window.history.replaceState({}, '', `/join/invite?identity=${hostIdentity}`);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'Invitation already used.' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ role: 'player', sessionId: 'show', identityId: playerIdentity }) });
    vi.stubGlobal('fetch', fetch);
    await expect(api.redeem('invite')).rejects.toThrow('Invitation already used.');
    expect(window.location.search).toBe(`?identity=${hostIdentity}`);
    await api.redeem('invite');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ token: 'invite', tab: true });
    expect(window.location.search).toBe(`?identity=${playerIdentity}`);
  });

  it('creates an authorized rehearsal seat without replacing the calling host identity', async () => {
    window.history.replaceState({}, '', `/?identity=${hostIdentity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'player', sessionId: 'show', identityId: playerIdentity }) });
    vi.stubGlobal('fetch', fetch);
    await api.testSeat('show', 'pc-1');
    expect(fetch).toHaveBeenCalledWith('/api/sessions/show/test-seat', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'X-RPG-Identity': hostIdentity }), body: JSON.stringify({ characterId: 'pc-1' }),
    }));
    expect(window.location.search).toBe(`?identity=${hostIdentity}`);
  });

  it.each(['', 'invalid', `${hostIdentity}&identity=${playerIdentity}`])('rejects an explicit invalid identity instead of using a shared cookie (%s)', async identity => {
    window.history.replaceState({}, '', `/?identity=${identity}`);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api.snapshot('show')).rejects.toThrow('identity');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('explicitly requests only the public projection on the stage route', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'stage' }) });
    vi.stubGlobal('fetch', fetch);
    await api.snapshot('a session', 'stage');
    expect(fetch).toHaveBeenCalledWith('/api/sessions/a%20session?view=stage', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('sends a command once and surfaces conflicts without retrying an old action', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'Your input changed. Review the latest stakes.' }) });
    vi.stubGlobal('fetch', fetch);
    await expect(api.command('session-1', { type: 'publish', commandId: 'cmd-1' } as never)).rejects.toThrow('Your input changed. Review the latest stakes.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reconnect and invalidations only request a fresh snapshot, never resend mutations', () => {
    const refresh = vi.fn();
    const connection = vi.fn();
    const close = subscribeToSession('session-1', refresh, connection);
    const callbacks = Object.fromEntries(socket.on.mock.calls);
    callbacks.connect();
    callbacks['session.snapshot_available']({ sessionId: 'session-1' });
    callbacks.disconnect();
    callbacks.connect();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(connection.mock.calls).toEqual([[true], [false], [true]]);
    close();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });
});

describe('stream links and producer access', () => {
  const identity = 'c'.repeat(32);
  const summary = { id: 'l1', sessionId: 's1', subject: 'show', label: 'Main', characterId: null, producerGrantId: null, canPresent: true, createdAt: 'a', expiresAt: 'b', revokedAt: null };
  const producer = { id: 'p1', label: 'Sam', createdAt: 'a', expiresAt: 'b', revokedAt: null, lastSignedInAt: null, activeSignIns: 0 };

  it('keeps tokens after the hash and layout and audio in the query', () => {
    const url = streamUrl('https://x.test', 'a+b/c', { layout: 'overlay', audio: 'listen' });
    expect(url).toBe('https://x.test/stream?layout=overlay&audio=listen#token=a%2Bb%2Fc');
    expect(url.split('#')[0]).not.toContain('a%2Bb');
    expect(producerUrl('https://x.test', 'tok')).toBe('https://x.test/producer#token=tok');
  });

  it('round-trips stream locations, ignores identity and falls back to scene', () => {
    const url = new URL(streamUrl('https://x.test', 'tok-1', { layout: 'overlay', audio: 'present' }) + '');
    url.searchParams.set('identity', identity);
    expect(parseStreamLocation(url)).toEqual({ token: 'tok-1', layout: 'overlay', audio: 'present', checker: false, check: false });
    expect(parseStreamLocation({ search: '?layout=weird&audio=loud&bg=checker&check=1', hash: '' })).toEqual({ token: null, layout: 'scene', audio: null, checker: true, check: true });
  });

  it('reads hash tokens', () => {
    expect(readHashToken('#token=a%2Bb')).toBe('a+b');
    expect(readHashToken('')).toBeNull();
    expect(readHashToken('#other=1')).toBeNull();
  });

  it('exchanges a stream token without an identity header', async () => {
    window.history.replaceState({}, '', `/stream?identity=${identity}`);
    const response = { identityId: identity, sessionId: 's1', link: { id: 'l1', label: 'Main', subject: 'show', characterId: null, canPresent: true }, expiresAt: 'x' };
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
    vi.stubGlobal('fetch', fetch);
    expect(await api.streamAccess('tok')).toEqual(response);
    expect(fetch.mock.calls[0][0]).toBe('/api/stream/access');
    expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'tok' });
  });

  it('selects the identity returned by producer sign-in', async () => {
    window.history.replaceState({}, '', '/producer');
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'producer', label: 'Sam', expiresAt: 'x', identityId: identity }) });
    vi.stubGlobal('fetch', fetch);
    await api.producerSignIn('tok');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'tok', tab: true });
    expect(window.location.search).toBe(`?identity=${identity}`);
  });

  it('sends a commandId when creating stream links and revoking producers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ link: summary, token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => producer });
    vi.stubGlobal('fetch', fetch);
    await api.createStreamLink('s1', { subject: 'show' });
    await api.revokeProducer('p/1');
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/s1/stream-links');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ commandId: expect.any(String), subject: 'show' });
    expect(fetch.mock.calls[1][0]).toBe('/api/producers/p%2F1/revoke');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ commandId: expect.any(String) });
  });
});
