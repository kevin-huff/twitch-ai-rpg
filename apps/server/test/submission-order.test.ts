import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { DirectorSnapshot, PlayerSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const suite = databaseUrl ? describe : describe.skip;

suite('submission order', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let player: string;
  let sessionId: string;
  const hostToken = randomBytes(24).toString('hex');
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  async function request(path: string, credential: string, payload?: unknown) {
    return app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  }
  async function command(value: Record<string, unknown>, credential: string) {
    const result = await request(`/api/sessions/${sessionId}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().snapshot;
  }

  beforeAll(async () => {
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    host = cookie(await request('/api/auth/host', '', { token: hostToken }));
    const created = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json();
    sessionId = created.sessionId;
    const invite = created.invites.find((item: { role: string }) => item.role === 'player');
    player = cookie(await request('/api/auth/redeem', '', { token: invite.token }));
  });
  afterAll(async () => { await app?.close(); });

  it('lists lines in the order they were first sent, and an edit keeps its place', async () => {
    let director = (await request(`/api/sessions/${sessionId}`, host)).json() as DirectorSnapshot;
    director = await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: director.session.inputEpoch }, host);
    const beatId = director.activeBeat!.id;
    const texts = Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`);
    for (const text of texts) {
      await command({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: beatId, expectedInputEpoch: director.session.inputEpoch, kind: 'say', text, recipientNpcIds: [director.npcs[0]!.id] }, player);
    }
    const mine = async () => ((await request(`/api/sessions/${sessionId}`, player)).json() as PlayerSnapshot).submissions;
    const theirs = async () => ((await request(`/api/sessions/${sessionId}`, host)).json() as DirectorSnapshot).submissions;
    expect((await mine()).map((item) => item.text)).toEqual(texts);
    expect((await theirs()).map((item) => item.text)).toEqual(texts);

    const second = (await mine())[1]!;
    await command({ type: 'save_submission', submissionId: second.id, expectedSubmissionRevision: 1, contextBeatId: beatId, expectedInputEpoch: director.session.inputEpoch, kind: 'say', text: 'Line 2 edited', recipientNpcIds: [director.npcs[0]!.id] }, player);
    const expected = texts.map((text) => (text === 'Line 2' ? 'Line 2 edited' : text));
    expect((await mine()).map((item) => item.text)).toEqual(expected);
    expect((await theirs()).map((item) => item.text)).toEqual(expected);
  });
});
