// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { api, subscribeToSession } from './api';
import { navigate, clearIdentity } from './navigate';
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

  describe('card generation calls', () => {
    const card = { schemaVersion: 1, displayName: 'Avery', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 1, finesse: 1, wits: 2, presence: 0 }, specialty: '', flaw: '', connection: '', secret: '', possessions: [], extensions: {} };
    const good = { card, notes: ['Kept what you already wrote.'], pronounsSuggested: false };
    const current = { kind: 'character' as const, displayName: 'Avery', secret: 'Private', possessions: ['', '', ''] };
    const spoof = { instructions: 'x', premise2: 'y', ids: 'z' };
    const ok = (body: unknown) => { const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal('fetch', fetch); return fetch; };
    const calls: Array<[string, string, () => Promise<unknown>, unknown]> = [
      ['generateCard', '/api/authoring/generate-card', () => api.generateCard({ prompt: 'A thief', keepFilled: true, current, premise: 'Storm', ...spoof } as never), { prompt: 'A thief', keepFilled: true, current, premise: 'Storm' }],
      ['generateBuilderCard', '/api/character-builder/generate-card', () => api.generateBuilderCard({ expectedRevision: 2, prompt: 'A thief', keepFilled: false, current, ...spoof } as never), { expectedRevision: 2, prompt: 'A thief', keepFilled: false, current }],
      ['generateSeatCard', '/api/sessions/show%2F1/character/generate-card', () => api.generateSeatCard('show/1', { expectedCharacterRevision: 4, prompt: 'A thief', keepFilled: true, current, ...spoof } as never), { expectedCharacterRevision: 4, prompt: 'A thief', keepFilled: true, current }],
    ];
    for (const [name, url, run, body] of calls) {
      it(`${name} posts only schema fields with the selected identity`, async () => {
        window.history.replaceState({}, '', `/x?identity=${playerIdentity}`);
        const fetch = ok(good);
        expect(await run()).toEqual(good);
        expect(fetch.mock.calls[0][0]).toBe(url);
        expect(fetch.mock.calls[0][1].method).toBe('POST');
        expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(playerIdentity);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
      });
      it(`${name} rejects a malformed card response`, async () => {
        ok({ card: { nope: true }, notes: [], pronounsSuggested: false });
        await expect(run()).rejects.toThrow();
      });
      it(`${name} surfaces the server message with its status`, async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'Your card changed.' }) }));
        await expect(run()).rejects.toMatchObject({ message: 'Your card changed.', status: 409 });
      });
    }

    it('generateSeatField posts only schema fields to the seat route', async () => {
      window.history.replaceState({}, '', `/x?identity=${playerIdentity}`);
      const fetch = ok({ text: 'A backstory' });
      const input = { expectedCharacterRevision: 1, field: 'character.backstory', seed: '', characterContext: current, usePremise: true };
      expect(await api.generateSeatField('show/1', { ...input, ...spoof } as never)).toEqual({ text: 'A backstory' });
      expect(fetch.mock.calls[0][0]).toBe('/api/sessions/show%2F1/character/generate-field');
      expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(playerIdentity);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    });

    it('refuses invalid bodies before sending a request', async () => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      await expect(api.generateCard({ prompt: '   ', keepFilled: true } as never)).rejects.toThrow();
      await expect(api.generateBuilderCard({ expectedRevision: -1, prompt: 'x', keepFilled: true, current } as never)).rejects.toThrow();
      await expect(api.generateSeatCard('s', { expectedCharacterRevision: 0, prompt: 'x', keepFilled: true, current: { kind: 'scenario' } } as never)).rejects.toThrow();
      expect(() => api.generateSeatField('s', { expectedCharacterRevision: 0, field: 'scenario.title', seed: '', characterContext: current, usePremise: false } as never)).toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('createCustom sends player-written seats next to template references', async () => {
      window.history.replaceState({}, '', `/library?identity=${hostIdentity}`);
      const fetch = ok({});
      await api.createCustom('Show', { templateId: 's', version: 1 }, [{ playerWritten: true }, { templateId: 'c', version: 2 }]);
      expect(JSON.parse(fetch.mock.calls[0][1].body).characters).toEqual([{ playerWritten: true }, { templateId: 'c', version: 2 }]);
    });
  });

  describe('scenario draft calls', () => {
    const jobId = 'job-1';
    const running = { status: 'running', jobId, size: 'medium', startedAt: '2026-10-24T10:00:00.000Z', deadlineAt: '2026-10-24T10:04:00.000Z' };
    const ok = (body: unknown) => { const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal('fetch', fetch); return fetch; };

    it('starts a draft with the host identity and only the requested fields', async () => {
      window.history.replaceState({}, '', `/library?identity=${hostIdentity}`);
      const fetch = ok(running);
      expect(await api.startScenarioDraft({ prompt: 'A flooded harbor', size: 'small', boundaries: ['No gore'], extra: 'x' } as never)).toEqual(running);
      expect(fetch.mock.calls[0][0]).toBe('/api/authoring/scenario-drafts');
      expect(fetch.mock.calls[0][1].method).toBe('POST');
      expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(hostIdentity);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ prompt: 'A flooded harbor', size: 'small', boundaries: ['No gore'] });
    });

    it('polls a draft by escaped job id with the host identity', async () => {
      window.history.replaceState({}, '', `/library?identity=${hostIdentity}`);
      const fetch = ok(running);
      expect(await api.scenarioDraft('job/1')).toEqual(running);
      expect(fetch.mock.calls[0][0]).toBe('/api/authoring/scenario-drafts/job%2F1');
      expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(hostIdentity);
    });

    it('rejects a malformed job response', async () => {
      ok({ status: 'running', jobId, size: 'huge' });
      await expect(api.scenarioDraft(jobId)).rejects.toThrow();
    });

    it('surfaces a 409 server message with its status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'A scenario draft is still being written. Wait for it to finish.' }) }));
      await expect(api.startScenarioDraft({ prompt: 'A flooded harbor', size: 'medium', boundaries: [] })).rejects.toMatchObject({ message: 'A scenario draft is still being written. Wait for it to finish.', status: 409 });
    });

    it('refuses an invalid start body before sending a request', async () => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      await expect(api.startScenarioDraft({ prompt: '   ', size: 'medium', boundaries: [] } as never)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });
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

  it('signs in browser-wide with only the token and removes a stale identity from the address', async () => {
    window.history.replaceState({}, '', `/sessions/show/director?identity=${hostIdentity}&view=review#notes`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'host', identityId: playerIdentity }) });
    vi.stubGlobal('fetch', fetch);
    await api.login('host-token');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'host-token' });
    expect(window.location.search).toBe('?view=review');
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

  it('signs in a producer with only the token and leaves no identity in the address', async () => {
    window.history.replaceState({}, '', `/producer?identity=${'c'.repeat(32)}#x`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ role: 'producer', label: 'Sam', expiresAt: 'x', identityId: identity }) });
    vi.stubGlobal('fetch', fetch);
    await api.producerSignIn('tok');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'tok' });
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#x');
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

describe('picture calls', () => {
  const imageId = '6f1c2b7e-9a3d-4e5f-8b21-0c4d5e6f7a8b';
  const details = { appearance: 'A tall ranger with a green cloak', role: 'Scout', pronouns: 'they/them', name: 'Avery' };
  const ok = (body: unknown) => { const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal('fetch', fetch); return fetch; };

  it('creates a seat portrait at its URL, posting the body and reading the picture id', async () => {
    const fetch = ok({ imageId });
    expect(await api.createSeatPortrait('show/1', { expectedCharacterRevision: 4, details })).toEqual({ imageId });
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/show%2F1/character/portrait');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ expectedCharacterRevision: 4, details });
  });

  it('creates a builder portrait at its URL', async () => {
    const fetch = ok({ imageId });
    expect(await api.createBuilderPortrait({ expectedRevision: 2, details })).toEqual({ imageId });
    expect(fetch.mock.calls[0][0]).toBe('/api/character-builder/portrait');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ expectedRevision: 2, details });
  });

  it('creates a library portrait at its URL, keeping the picture style', async () => {
    const fetch = ok({ imageId });
    expect(await api.createLibraryPortrait({ subject: 'npc', subjectKey: 'npc-1', details, pictureStyle: 'Ink sketch' })).toEqual({ imageId });
    expect(fetch.mock.calls[0][0]).toBe('/api/library/portraits');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ subject: 'npc', subjectKey: 'npc-1', details, pictureStyle: 'Ink sketch' });
  });

  it('rejects a portrait body with an extra key before fetching', async () => {
    const fetch = ok({ imageId });
    await expect(api.createSeatPortrait('show-1', { expectedCharacterRevision: 4, details, extra: true } as never)).rejects.toThrow();
    await expect(api.createBuilderPortrait({ expectedRevision: 2, details, extra: true } as never)).rejects.toThrow();
    await expect(api.createLibraryPortrait({ subject: 'card', subjectKey: 'card-1', details, extra: true } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed picture reply', async () => {
    ok({ imageId: 'not-a-uuid' });
    await expect(api.createBuilderPortrait({ expectedRevision: 2, details })).rejects.toThrow();
  });

  it('draws a beat picture at its URL with an empty body and reads the picture id', async () => {
    const fetch = ok({ imageId });
    expect(await api.drawBeatPicture('show/1')).toEqual({ imageId });
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/show%2F1/beat-picture');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
  });

  it('saves picture settings at their URL and reads the effective settings back', async () => {
    const settings = { style: 'Ink sketch', model: 'flux-3-klein' };
    const fetch = ok(settings);
    expect(await api.savePictureSettings('show/1', settings)).toEqual(settings);
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/show%2F1/picture-settings');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(settings);
  });

  it('rejects picture settings with an extra key or a malformed reply before fetching', async () => {
    const fetch = ok({ style: '', model: 'krea-2-turbo' });
    await expect(api.savePictureSettings('show-1', { style: '', model: 'krea-2-turbo', extra: true } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    ok({ style: '', model: 'Not A Model!' });
    await expect(api.savePictureSettings('show-1', { style: '', model: 'krea-2-turbo' })).rejects.toThrow();
  });

  it('posts the scene and NPC picture actions with an empty body and encoded ids', async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => api.newScenePicture('show/1'), '/api/sessions/show%2F1/scene-picture'],
      [() => api.hideScenePicture('show/1'), '/api/sessions/show%2F1/scene-picture/hide'],
      [() => api.showScenePicture('show/1'), '/api/sessions/show%2F1/scene-picture/show'],
      [() => api.createNpcPortrait('show/1', 'npc 1'), '/api/sessions/show%2F1/npcs/npc%201/portrait'],
      [() => api.removeNpcPortrait('show/1', 'npc 1'), '/api/sessions/show%2F1/npcs/npc%201/portrait/remove'],
    ];
    for (const [run, url] of cases) {
      const fetch = ok({ ok: true });
      expect(await run()).toEqual({ ok: true });
      expect(fetch.mock.calls[0][0]).toBe(url);
      expect(fetch.mock.calls[0][1].method).toBe('POST');
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
      vi.unstubAllGlobals();
    }
  });
});

describe('gallery and session list calls', () => {
  const playerIdentity = 'b'.repeat(32);
  const slug = 'a'.repeat(43);
  const status = { state: 'on', listed: false, url: `https://x.test/gallery/${slug}/`, listUrl: 'https://x.test/gallery/', pictures: 3, pending: 0, writtenAt: '2026-10-25T20:14:00.000Z', message: null, local: false };
  const ok = (body: unknown) => { const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }); vi.stubGlobal('fetch', fetch); return fetch; };

  it('galleryAction posts the action to the encoded session with the selected identity and returns the parsed status', async () => {
    window.history.replaceState({}, '', `/x?identity=${playerIdentity}`);
    const fetch = ok(status);
    expect(await api.galleryAction('show/1', 'list')).toEqual(status);
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/show%2F1/gallery');
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(fetch.mock.calls[0][1].credentials).toBe('same-origin');
    expect(fetch.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBe(playerIdentity);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: 'list' });
    vi.unstubAllGlobals();
  });

  it('galleryAction rejects an invalid action before fetch is called', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api.galleryAction('show', 'publish' as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('galleryAction rejects a malformed status response', async () => {
    ok({ ...status, state: 'maybe' });
    await expect(api.galleryAction('show', 'on')).rejects.toThrow();
  });

  it('sessions returns entries with a null gallery and with a gallery link', async () => {
    const entries = [
      { id: 'one', title: 'First', status: 'ended', gallery: null },
      { id: 'two', title: 'Second', status: 'ended', gallery: { listed: true, url: `https://x.test/gallery/${slug}/` } },
    ];
    ok(entries);
    expect(await api.sessions()).toEqual(entries);
    vi.unstubAllGlobals();
  });

  it('sessions rejects an entry with an extra key', async () => {
    ok([{ id: 'one', title: 'First', status: 'ended', gallery: null, extra: true }]);
    await expect(api.sessions()).rejects.toThrow();
  });
});

describe('invitation preview and navigation', () => {
  const identity = 'a'.repeat(32);

  it('previews an invitation without the identity header and parses the reply', async () => {
    window.history.replaceState({}, '', `/join/x?identity=${identity}`);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ title: 'The Ledger Job', role: 'player', characterName: 'Mara' }) });
    vi.stubGlobal('fetch', fetch);
    expect(await api.invitePreview('tok')).toEqual({ title: 'The Ledger Job', role: 'player', characterName: 'Mara' });
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/invite-preview');
    expect(fetch.mock.calls[0][1].headers['X-RPG-Identity']).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'tok' });
  });

  it('surfaces a rejected invitation as an ApiError with the server message', async () => {
    const message = 'This invitation is expired, already redeemed, or invalid.';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message }) }));
    await expect(api.invitePreview('bad')).rejects.toMatchObject({ name: 'Error', status: 401, message });
  });

  it('clearIdentity removes identity parameters and keeps the rest of the address', () => {
    window.history.replaceState({}, '', `/a/b?x=1&identity=${identity}&y=2#h`);
    clearIdentity();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/a/b?x=1&y=2#h');
  });

  it('navigate carries the current identity and replaces or assigns', () => {
    window.history.replaceState({}, '', `/?identity=${identity}`);
    const replace = vi.fn();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { origin: original.origin, search: original.search, href: original.href, replace, assign } });
    try {
      navigate('/sessions/s1/play', { replace: true });
      navigate('/library');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
    expect(replace).toHaveBeenCalledWith(`/sessions/s1/play?identity=${identity}`);
    expect(assign).toHaveBeenCalledWith(`/library?identity=${identity}`);
  });
});
