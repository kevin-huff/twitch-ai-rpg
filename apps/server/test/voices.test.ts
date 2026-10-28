import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FAKE_VOICES, type VoiceList, type VoiceOption, type VoiceSource } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { VoiceCatalog } from '../src/voices';

const voice = (name: string, group: VoiceOption['group'], tuned: boolean): VoiceOption =>
  ({ id: `eleven:${name.toLowerCase()}`, name, group, summary: '', previewUrl: null, tuned });
const UNAVAILABLE = 'The voice list is unavailable right now. Everyone keeps the narrator.';

describe('voice catalog', () => {
  it('sorts by group, tuned first, then name without case', async () => {
    const source: VoiceSource = { listVoices: async () => ({ voices: [
      voice('zed', 'standard', true), voice('Amy', 'standard', false), voice('bo', 'added', false), voice('Yan', 'clone', false), voice('Xi', 'clone', true), voice('al', 'clone', true), voice('Cal', 'standard', true),
    ] }) };
    const list = await new VoiceCatalog(source).listVoices();
    expect(list.voices.map(entry => entry.name)).toEqual(['al', 'Xi', 'Yan', 'bo', 'Cal', 'zed', 'Amy']);
  });

  it('keeps a good list for the ttl and then asks again', async () => {
    let clock = 1000;
    const listVoices = vi.fn(async (): Promise<VoiceList> => ({ voices: [voice('Ann', 'clone', true)] }));
    const catalog = new VoiceCatalog({ listVoices }, { ttlMs: 600_000, now: () => clock });
    await catalog.listVoices();
    clock += 599_999;
    await catalog.listVoices();
    expect(listVoices).toHaveBeenCalledTimes(1);
    clock += 1;
    await catalog.listVoices();
    expect(listVoices).toHaveBeenCalledTimes(2);
  });

  it('does not keep a list with a reason', async () => {
    const listVoices = vi.fn()
      .mockResolvedValueOnce({ voices: [voice('Ann', 'clone', true)], reason: 'Out of credits.' })
      .mockResolvedValueOnce({ voices: [voice('Ann', 'clone', true)] });
    const catalog = new VoiceCatalog({ listVoices });
    expect(await catalog.listVoices()).toEqual({ voices: [], reason: 'Out of credits.' });
    expect((await catalog.listVoices()).voices).toHaveLength(1);
    expect(listVoices).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    let release!: (list: VoiceList) => void;
    const listVoices = vi.fn(() => new Promise<VoiceList>(resolve => { release = resolve; }));
    const catalog = new VoiceCatalog({ listVoices });
    const calls = [catalog.listVoices(), catalog.listVoices(), catalog.listVoices()];
    release({ voices: [voice('Ann', 'clone', true)] });
    const results = await Promise.all(calls);
    expect(listVoices).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.voices.length === 1)).toBe(true);
  });

  it('turns a thrown error into the pinned reason and tries again next time', async () => {
    const listVoices = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ voices: [voice('Ann', 'clone', true)] });
    const catalog = new VoiceCatalog({ listVoices });
    expect(await catalog.listVoices()).toEqual({ voices: [], reason: UNAVAILABLE });
    expect((await catalog.listVoices()).voices).toHaveLength(1);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'voices-test-host-credential-0001';

suite('voice list route', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  async function boot(options: Record<string, unknown> = {}) {
    const app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, ...options });
    apps.push(app);
    const call = (url: string, credential: string, payload?: unknown) =>
      app.inject({ method: payload ? 'POST' : 'GET', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload ? { payload } : {}) });
    const host = cookie(await call('/api/auth/host', '', { token: hostToken }));
    return { app, call, host };
  }
  async function table(call: Awaited<ReturnType<typeof boot>>['call'], host: string) {
    const created = (await call('/api/sessions', host, { commandId: crypto.randomUUID() })).json();
    let player = ''; let stage = '';
    for (const invite of created.invites) {
      const redeemed = cookie(await call('/api/auth/redeem', '', { token: invite.token }));
      if (invite.role === 'player' && !player) player = redeemed;
      if (invite.role === 'stage') stage = redeemed;
    }
    return { sessionId: created.sessionId as string, player, stage };
  }
  afterAll(async () => { for (const app of apps) await app.close(); });
  beforeAll(() => undefined);

  it('serves the sorted list to host, player and stage, and refuses no credential', async () => {
    const custom: VoiceSource = { listVoices: async () => ({ voices: [voice('Zed', 'standard', true), voice('Amy', 'clone', false)] }) };
    const { call, host } = await boot({ voiceCatalog: custom });
    const { player, stage } = await table(call, host);
    for (const credential of [host, player, stage]) {
      const response = await call('/api/voices', credential);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().voices.map((entry: VoiceOption) => entry.name)).toEqual(['Amy', 'Zed']);
    }
    expect((await call('/api/voices', '')).statusCode).toBe(401);
  });

  it('asks the source once for two requests', async () => {
    const listVoices = vi.fn(async (): Promise<VoiceList> => ({ voices: [voice('Amy', 'clone', true)] }));
    const { call, host } = await boot({ voiceCatalog: { listVoices } });
    await call('/api/voices', host);
    await call('/api/voices', host);
    expect(listVoices).toHaveBeenCalledTimes(1);
  });

  it('lists the three fake voices when nothing supplies voices', async () => {
    const { call, host } = await boot();
    const response = await call('/api/voices', host);
    expect(response.json().voices.map((entry: VoiceOption) => entry.id)).toEqual(FAKE_VOICES.map(entry => entry.id));
  });

  it('uses a speech engine that can list voices', async () => {
    const listVoices = vi.fn(async (): Promise<VoiceList> => ({ voices: [voice('Eve', 'added', true)] }));
    const speech = { synthesize: async () => ({ bytes: new Uint8Array(), contentType: 'audio/mpeg' }), listVoices };
    const { call, host } = await boot({ speech });
    expect((await call('/api/voices', host)).json().voices[0].name).toBe('Eve');
  });

  it('lets set_voice accept a voice only a custom catalog lists', async () => {
    const { call, host } = await boot({ voiceCatalog: { listVoices: async () => ({ voices: [voice('Only', 'clone', true)] }) } });
    const { sessionId, player } = await table(call, host);
    const accepted = await call(`/api/sessions/${sessionId}/commands`, player, { commandId: crypto.randomUUID(), type: 'set_voice', voiceProfileId: 'eleven:only' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const refused = await call(`/api/sessions/${sessionId}/commands`, player, { commandId: crypto.randomUUID(), type: 'set_voice', voiceProfileId: 'eleven:fake-ada' });
    expect(refused.statusCode).toBe(409);
  });

  it('keeps the first-voice pick for a new story and gives an unlisted pick the narrator', async () => {
    const { call, host } = await boot();
    const job = (await call('/api/authoring/scenario-drafts', host, { prompt: 'A harbor fair' })).json();
    let done: { status: string; definition?: { npcs: { displayName: string; voiceProfileId: string }[] } } = { status: 'running' };
    for (let i = 0; i < 200 && done.status === 'running'; i++) {
      done = (await call(`/api/authoring/scenario-drafts/${job.jobId}`, host)).json();
      if (done.status === 'running') await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(done.status).toBe('succeeded');
    const npcs = done.definition!.npcs;
    expect(npcs.find(npc => npc.displayName === 'Ines Park')!.voiceProfileId).toBe(FAKE_VOICES[0]!.id);
    expect(npcs.find(npc => npc.displayName === 'Tomas Reed')!.voiceProfileId).toBe('narrator');
  });
});
