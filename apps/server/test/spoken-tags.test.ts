import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftAudioResponseSchema } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const written = '<grin> Nice hat, Mara. <whispers>Did you lose a bet?</whispers> I <3 it.';
const cleaned = 'Nice hat, Mara. Did you lose a bet? I <3 it.';

suite('tag-like words in player lines keep the voice working', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let directory: string;
  let host: string;
  let stage: string;
  let sessionId: string;
  let snapshot: any;
  const synthesize = vi.fn(async (input: { text: string; voiceProfileId: string }) => {
    if (/<\/?[a-z][^>]*>/i.test(input.text)) throw new Error('The speech engine rejects tag-like text.');
    return { bytes: new Uint8Array([73, 68, 51, 1]), contentType: 'audio/mpeg' };
  });
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: object, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  async function command(type: string, fields: Record<string, unknown> = {}) {
    const response = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type, ...fields });
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
  }
  const beat = (type: string, fields = {}) => command(type, { beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, ...fields });

  beforeEach(async () => {
    synthesize.mockClear();
    directory = await mkdtemp(join(tmpdir(), 'rpg-spoken-tags-'));
    const hostToken = `spoken-tags-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, provider: new FakeAiProvider(), rollDie: () => 4, speech: { synthesize }, speechModel: 'tags-test-model', speechVoiceId: 'tags-test-voice', assetDir: directory });
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
    const creation = (await request('/api/sessions', { commandId: randomUUID() })).json();
    sessionId = creation.sessionId;
    const invite = (role: string) => creation.invites.find((entry: any) => entry.role === role).token;
    stage = cookie(await request('/api/auth/redeem', { token: invite('stage') }, ''));
    const player = cookie(await request('/api/auth/redeem', { token: invite('player') }, ''));
    snapshot = (await request(`/api/sessions/${sessionId}`)).json();
    await command('open_beat', { kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    const saved = await request(`/api/sessions/${sessionId}/commands`, { type: 'save_submission', commandId: randomUUID(), contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: written, recipientNpcIds: [snapshot.npcs[0].id] }, player);
    expect(saved.statusCode, saved.body).toBe(200);
    await beat('plan_beat', { submissionIds: saved.json().snapshot.submissions.map((submission: any) => submission.id) });
    await beat('approve_stakes', { classification: 'ordinary', contracts: [] });
    await beat('lock_beat');
    await beat('render_beat');
  });
  afterEach(async () => { await app?.close(); await pool?.end(); await rm(directory, { recursive: true, force: true }); });

  it('sends the cleaned line with the name to the speech engine and publishes the words exactly as written', async () => {
    const name = snapshot.characters.find((character: any) => character.id === snapshot.activeBeat.lockedSubmissions[0].characterId).displayName as string;
    const prepared = await request(`/api/sessions/${sessionId}/beats/${snapshot.activeBeat.id}/draft-audio`, { commandId: randomUUID(), expectedBeatRevision: snapshot.activeBeat.revision, draftRevision: snapshot.activeBeat.draftRevision, generation: snapshot.activeBeat.generation });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const body = DraftAudioResponseSchema.parse(prepared.json());
    expect(body.status).toBe('ready');
    if (body.status !== 'ready') throw new Error('Expected prepared draft narration.');
    expect(synthesize.mock.calls[0]![0].text).toBe(`${name}: ${cleaned}`);
    expect(body.manifest.segments[0]).toMatchObject({ text: written, speaker: name });

    await beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: false, audioPreparationId: body.manifest.preparationId });
    const publication = snapshot.history.at(-1);
    expect(publication.textOnly).toBe(false);
    const dialogue = publication.segments.find((segment: any) => segment.kind === 'player_dialogue');
    expect(dialogue.text).toBe(written);
    const published = (await request(`/api/sessions/${sessionId}/audio/${publication.id}`, undefined, stage)).json();
    expect(published.status).toBe('ready');
    expect(published.manifest.segments[0].text).toBe(written);
  });
});
