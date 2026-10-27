import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

suite('changing the show status', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let hostCookie: string;
  const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  const call = (url: string, payload?: Record<string, unknown>, cookie = hostCookie) =>
    app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: `rpg_session=${cookie}` }, ...(payload === undefined ? {} : { payload }) });
  const snapshot = async (sessionId: string) => (await call(`/api/sessions/${sessionId}`)).json() as any;
  const send = (sessionId: string, command: Record<string, unknown>, cookie = hostCookie) =>
    call(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...command }, cookie);
  const setStatus = async (sessionId: string, status: string) => send(sessionId, { type: 'set_status', status, expectedStateRevision: (await snapshot(sessionId)).session.stateRevision });
  const beatCommand = async (sessionId: string, type: string, extras: Record<string, unknown> = {}) => {
    const beat = (await snapshot(sessionId)).activeBeat;
    const response = await send(sessionId, { type, beatId: beat.id, expectedBeatRevision: beat.revision, ...extras });
    expect(response.statusCode, response.body).toBe(200);
  };

  beforeEach(async () => {
    const hostToken = `set-status-host-${randomUUID()}`;
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    hostCookie = cookieOf(signIn);
  });
  afterEach(async () => { await app?.close(); });

  async function customShow() {
    const starter = (await call('/api/library/starter')).json() as { scenario: Record<string, any>; characters: Array<Record<string, any>> };
    const scenario = (await call('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const refs = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const saved = (await call('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      refs.push({ templateId: saved.id, version: saved.version });
    }
    const made = await call('/api/sessions', { commandId: randomUUID(), scenario: { templateId: scenario.id, version: scenario.version }, characters: refs });
    expect(made.statusCode, made.body).toBe(200);
    return made.json().sessionId as string;
  }

  async function practiceShow() {
    const made = await call('/api/sessions', { commandId: randomUUID() });
    expect(made.statusCode, made.body).toBe(200);
    const body = made.json();
    const redeemed = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: body.invites.find((invite: any) => invite.role === 'player').token } });
    expect(redeemed.statusCode).toBe(200);
    return { sessionId: body.sessionId as string, playerCookie: cookieOf(redeemed) };
  }

  it('refuses live and paused before the start on a custom show, but accepts ended', async () => {
    const sessionId = await customShow();
    for (const status of ['live', 'paused']) {
      const refused = await setStatus(sessionId, status);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().message).toBe('Start the show from Cast & lobby.');
      expect((await snapshot(sessionId)).session.status).toBe('lobby');
    }
    const ended = await setStatus(sessionId, 'ended');
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await snapshot(sessionId)).session.status).toBe('ended');
  });

  it('lets the practice show pause while it is still in the lobby', async () => {
    const { sessionId } = await practiceShow();
    expect((await snapshot(sessionId)).session.status).toBe('lobby');
    const paused = await setStatus(sessionId, 'paused');
    expect(paused.statusCode, paused.body).toBe(200);
    expect((await snapshot(sessionId)).session.status).toBe('paused');
  });

  it('will not end the show with a locked beat, and ends it after the beat is abandoned', async () => {
    const { sessionId, playerCookie } = await practiceShow();
    const opened = await send(sessionId, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: (await snapshot(sessionId)).session.inputEpoch });
    expect(opened.statusCode, opened.body).toBe(200);
    const open = await snapshot(sessionId);
    expect(open.session.status).toBe('live');
    const line = await send(sessionId, { type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: open.activeBeat.id, expectedInputEpoch: open.session.inputEpoch, kind: 'say', text: 'Tell me what you saw.', recipientNpcIds: [open.npcs[0].id] }, playerCookie);
    expect(line.statusCode, line.body).toBe(200);
    const queued = (await snapshot(sessionId)).submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id);
    await beatCommand(sessionId, 'plan_beat', { submissionIds: queued });
    await beatCommand(sessionId, 'approve_stakes', { classification: 'ordinary', contracts: [] });
    await beatCommand(sessionId, 'lock_beat');

    const refused = await setStatus(sessionId, 'ended');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toBe('Publish or abandon the beat in progress before ending the show.');
    expect((await snapshot(sessionId)).session.status).toBe('live');

    await beatCommand(sessionId, 'abort_beat', { reason: 'Starting over' });
    const ended = await setStatus(sessionId, 'ended');
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await snapshot(sessionId)).session.status).toBe('ended');
  });
});
