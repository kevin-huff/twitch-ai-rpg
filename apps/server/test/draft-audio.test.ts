import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftAudioResponseSchema } from '@rpg/contracts';
import { speechCacheKey } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';
import { cachedSpeech } from '../src/draft-audio';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const model = 'draft-test-model';
const voiceId = 'draft-test-voice';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const audio = (bytes = [73, 68, 51, 1]) => ({ bytes: new Uint8Array(bytes), contentType: 'audio/mpeg' });

suite('private saved draft speech and publication attachment', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let directory: string;
  let hostToken: string;
  let host: string;
  let stage: string;
  let player: string;
  let sessionId: string;
  let snapshot: any;
  let provider: FakeAiProvider;
  const synthesize = vi.fn(async (_input: { text: string; voiceProfileId: string }) => audio());
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: object, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const draftPath = () => `/api/sessions/${sessionId}/beats/${snapshot.activeBeat.id}/draft-audio`;
  const prepareBody = () => ({ commandId: randomUUID(), expectedBeatRevision: snapshot.activeBeat.revision, draftRevision: snapshot.activeBeat.draftRevision, generation: snapshot.activeBeat.generation });
  async function command(type: string, fields: Record<string, unknown> = {}, credential = host) {
    const response = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type, ...fields }, credential);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatFields = () => ({ beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision });
  const beat = (type: string, fields = {}) => command(type, { ...beatFields(), ...fields });
  async function prepare() {
    const result = await request(draftPath(), prepareBody());
    expect(result.statusCode, result.body).toBe(200);
    const body = DraftAudioResponseSchema.parse(result.json());
    expect(body.status).toBe('ready');
    if (body.status !== 'ready') throw new Error('Expected prepared draft narration.');
    return body.manifest;
  }
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 5)); }
    throw new Error('Expected asynchronous operation did not reach its checkpoint.');
  }
  async function lockWait() {
    await waitFor(async () => Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND pid<>pg_backend_pid()")).rowCount));
  }
  async function publish(preparationId?: string) {
    return beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: !preparationId, ...(preparationId ? { audioPreparationId: preparationId } : {}) });
  }
  beforeEach(async () => {
    synthesize.mockReset(); synthesize.mockImplementation(async () => audio());
    directory = await mkdtemp(join(tmpdir(), 'rpg-draft-audio-'));
    hostToken = `draft-audio-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    provider = new FakeAiProvider();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, provider, rollDie: () => 4, speech: { synthesize }, speechModel: model, speechVoiceId: voiceId, assetDir: directory });
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
    const creation = (await request('/api/sessions', { commandId: randomUUID() })).json();
    sessionId = creation.sessionId;
    for (const role of ['stage', 'player']) {
      const credential = cookie(await request('/api/auth/redeem', { token: creation.invites.find((invite: any) => invite.role === role).token }, ''));
      if (role === 'stage') stage = credential; else player = credential;
    }
    snapshot = (await request(`/api/sessions/${sessionId}`)).json();
    await command('open_beat', { kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    const saved = await request(`/api/sessions/${sessionId}/commands`, { type: 'save_submission', commandId: randomUUID(), contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: 'The private player quote must never reach speech.', recipientNpcIds: [snapshot.npcs[0].id] }, player);
    expect(saved.statusCode).toBe(200);
    await beat('plan_beat', { submissionIds: saved.json().snapshot.submissions.map((submission: any) => submission.id) });
    await beat('approve_stakes', { classification: 'ordinary', contracts: [] });
    await beat('lock_beat');
    await beat('render_beat');
  });
  afterEach(async () => { await app?.close(); await pool?.end(); await rm(directory, { recursive: true, force: true }); });

  it('privately prepares only saved narrator/NPC speech and denies every non-owning role and public cache hash', async () => {
    const path = draftPath();
    expect((await request(path)).json()).toEqual({ status: 'missing' });
    for (const credential of [stage, player, '']) {
      expect((await request(path, undefined, credential)).statusCode).toBe(credential ? 403 : 401);
      expect((await request(path, prepareBody(), credential)).statusCode).toBe(credential ? 403 : 401);
    }
    const manifest = await prepare();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(synthesize.mock.calls)).not.toMatch(/private player quote|archive safe|brass key/);
    expect(JSON.stringify(manifest)).not.toMatch(/[a-f0-9]{64}/);
    expect(manifest.segments.map(segment => segment.index)).toEqual([0, 1]);
    for (const segment of manifest.segments) {
      const media = await request(segment.url);
      expect(media.statusCode).toBe(200);
      expect(media.headers['cache-control']).toBe('no-store');
      for (const credential of [stage, player, '']) expect((await request(segment.url, undefined, credential)).statusCode).toBe(credential ? 403 : 401);
    }
    const assets = await pool.query('SELECT id FROM audio_assets WHERE session_id=$1', [sessionId]);
    for (const asset of assets.rows) for (const credential of [host, stage, player]) expect((await request(`/api/sessions/${sessionId}/audio/assets/${asset.id}`, undefined, credential)).statusCode).toBe(404);
    expect((await request(path, { ...prepareBody(), text: 'Forged unsaved speech.' })).statusCode).toBe(400);
  });

  it('reuses current recordings and exact receipts across continuity-only revisions without paid work', async () => {
    const body = prepareBody(); const path = draftPath();
    const first = await request(path, body);
    expect(first.statusCode, first.body).toBe(200);
    expect((await request(path, body)).json()).toEqual(first.json());
    expect((await request(path, { ...body, generation: body.generation + 1 })).statusCode).toBe(409);
    await beat('approve_continuity', { updates: [] });
    expect((await request(path, body)).json()).toEqual(first.json());
    expect((await request(path)).json()).toEqual(first.json());
    expect((await request(path, prepareBody())).json()).toEqual(first.json());
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('never reexposes an edited recording through an old receipt or indexed URL', async () => {
    const path = draftPath(); const body = prepareBody();
    const ready = (await request(path, body)).json();
    await beat('edit_script', { segments: [{ kind: 'narration', text: 'A new saved line.', delivery: 'quiet', recipientCharacterIds: [] }] });
    expect((await request(path)).json()).toEqual({ status: 'missing' });
    expect((await request(path, body)).statusCode).toBe(409);
    expect((await request(ready.manifest.segments[0].url)).statusCode).toBe(409);
    const replacement = await prepare();
    expect(replacement.preparationId).not.toBe(ready.manifest.preparationId);
    expect(replacement.segments[0].text).toBe('A new saved line.');
  });

  it('discards a late provider completion after saved script changes without holding a session lock during speech', async () => {
    const gate = deferred<ReturnType<typeof audio>>();
    synthesize.mockImplementationOnce(() => gate.promise);
    const path = draftPath(); const body = prepareBody();
    const pending = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    await beat('edit_script', { segments: [{ kind: 'narration', text: 'The replacement wins.', delivery: 'neutral', recipientCharacterIds: [] }] });
    gate.resolve(audio());
    expect((await pending).statusCode).toBe(409);
    expect((await request(path)).json()).toEqual({ status: 'missing' });
    expect((await request(path, body)).statusCode).toBe(409);
  });

  it('coalesces current in-flight requests and requires a new explicit command after failure', async () => {
    const gate = deferred<ReturnType<typeof audio>>();
    synthesize.mockImplementationOnce(() => gate.promise);
    const path = draftPath(); const body = prepareBody();
    const pending = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const preparing = await request(path, body);
    expect(preparing.json()).toMatchObject({ status: 'preparing' });
    expect((await request(path, prepareBody())).json()).toEqual(preparing.json());
    gate.resolve(audio()); expect((await pending).json().status).toBe('ready');
    await beat('edit_script', { segments: [{ kind: 'narration', text: 'A fresh line that fails.', delivery: 'neutral', recipientCharacterIds: [] }] });
    synthesize.mockRejectedValueOnce(new Error('Provider secret must remain private.'));
    const failureBody = prepareBody(); const failed = await request(path, failureBody);
    expect(failed.statusCode, failed.body).toBe(200); expect(failed.json().status).toBe('failed');
    const calls = synthesize.mock.calls.length;
    expect((await request(path, failureBody)).json()).toEqual(failed.json());
    expect(synthesize).toHaveBeenCalledTimes(calls);
    expect((await prepare()).segments[0].text).toBe('A fresh line that fails.');
  });

  it('fences an expired worker after a lock wait before any next paid segment and allows an explicit replacement', async () => {
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const path = draftPath(), body = prepareBody();
    const pending = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const preparing = (await request(path)).json();
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      await client.query("UPDATE draft_audio_preparations SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1", [preparing.preparationId]);
      gate.resolve(audio()); await lockWait();
      await pool.query('SELECT pg_sleep(0.2)');
      await client.query('COMMIT');
      expect((await pending).statusCode).toBe(409);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((await request(path, body)).json()).toEqual({ status: 'failed', preparationId: preparing.preparationId });
    const fresh = await prepare();
    expect(fresh.preparationId).not.toBe(preparing.preparationId);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('allows a replacement after expiry while the old worker is still pending without letting it overwrite readiness', async () => {
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const path = draftPath(), body = prepareBody();
    const obsolete = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const old = (await request(path)).json();
    await pool.query("UPDATE draft_audio_preparations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.preparationId]);
    const replacement = request(path, prepareBody()).then(value => value);
    await waitFor(async () => Number((await pool.query('SELECT count(*) FROM draft_audio_preparations WHERE session_id=$1', [sessionId])).rows[0].count) === 2);
    gate.resolve(audio());
    expect((await obsolete).statusCode).toBe(409);
    const ready = await replacement;
    expect(ready.statusCode, ready.body).toBe(200); expect(ready.json().status).toBe('ready');
    expect(ready.json().manifest.preparationId).not.toBe(old.preparationId);
    expect((await request(path)).json()).toEqual(ready.json());
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it.each(['steering', 'abort', 'text-only publication'])('discards a late preparation after %s', async change => {
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const path = draftPath(), body = prepareBody();
    const pending = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    if (change === 'steering') await beat('set_beat_steering', { text: 'Change the next saved performance.' });
    else if (change === 'abort') await beat('abort_beat', { reason: 'Discard this saved scene.' });
    else await publish();
    gate.resolve(audio());
    expect((await pending).statusCode).toBe(409);
    expect((await request(path, body)).statusCode).toBe(409);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('invalidates preparation as soon as rerender starts even before the draft revision changes', async () => {
    const speechGate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => speechGate.promise);
    const path = draftPath(), body = prepareBody();
    const preparing = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const renderGate = deferred<void>(), render = provider.render.bind(provider);
    vi.spyOn(provider, 'render').mockImplementationOnce(async context => { await renderGate.promise; return render(context); });
    const rerender = beat('render_beat');
    await waitFor(async () => Boolean((await pool.query("SELECT 1 FROM generation_jobs WHERE beat_id=$1 AND status='running' AND generation>$2", [snapshot.activeBeat.id, body.generation])).rowCount));
    expect((await pool.query('SELECT data FROM beats WHERE id=$1', [snapshot.activeBeat.id])).rows[0].data.draftRevision).toBe(body.draftRevision);
    speechGate.resolve(audio());
    expect((await preparing).statusCode).toBe(409);
    renderGate.resolve(); await rerender;
    expect((await request(path, body)).statusCode).toBe(409);
  });

  it('publishes the exact selected preview under fresh canonical segment IDs and retains publication retries', async () => {
    await beat('abort_beat', { reason: 'Rehearse an action with fixed dice.' });
    await command('open_beat', { kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const submitted = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'act', text: '', intent: 'Open the archive mechanism', approach: 'Careful investigation' }, player);
    expect(submitted.statusCode, submitted.body).toBe(200);
    await beat('plan_beat', { submissionIds: submitted.json().snapshot.submissions.filter((submission: any) => submission.status === 'queued').map((submission: any) => submission.id) });
    await beat('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat.contracts });
    await beat('lock_beat'); await beat('render_beat');
    const preview = await prepare(); const path = draftPath(); const prior = structuredClone(snapshot.activeBeat.resolution);
    expect(prior.rolls).toHaveLength(1);
    const fields = { ...beatFields(), commandId: randomUUID(), type: 'publish_beat', expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.preparationId };
    const first = await request(`/api/sessions/${sessionId}/commands`, fields);
    expect(first.statusCode, first.body).toBe(200);
    expect((await request(`/api/sessions/${sessionId}/commands`, fields)).json()).toEqual(first.json());
    const publication = first.json().snapshot.history.at(-1);
    expect(publication.textOnly).toBe(false); expect(publication.audioManifestKey).toMatch(/^[a-f0-9]{64}$/);
    expect(publication.rolls).toEqual(prior.rolls);
    expect((await pool.query('SELECT data FROM rolls WHERE session_id=$1', [sessionId])).rows.map(row => row.data)).toEqual(prior.rolls);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE session_id=$1 AND kind='beat.published'", [sessionId])).rowCount).toBe(1);
    expect(first.json().snapshot.session.actionRoundNumber).toBe(1);
    const publicAudio = (await request(`/api/sessions/${sessionId}/audio/${publication.id}`, undefined, stage)).json();
    expect(publicAudio.status).toBe('ready');
    expect(publicAudio.manifest.segments.map((segment: any) => segment.id)).toEqual(publication.segments.filter((segment: any) => segment.kind === 'narration' || segment.kind === 'npc_dialogue').map((segment: any) => segment.id));
    expect(publicAudio.manifest.segments.map((segment: any) => segment.text)).toEqual(preview.segments.map(segment => segment.text));
    for (const segment of publicAudio.manifest.segments) expect((await request(segment.url, undefined, stage)).statusCode).toBe(200);
    expect((await request(preview.segments[0].url)).statusCode).toBe(409);
    expect((await request(path)).statusCode).toBe(409);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('rolls publication back if a selected recording asset is missing', async () => {
    const preview = await prepare();
    const before = (await request(`/api/sessions/${sessionId}`)).json();
    await pool.query('DELETE FROM audio_assets WHERE session_id=$1', [sessionId]);
    const failed = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'publish_beat', ...beatFields(), expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.preparationId });
    expect(failed.statusCode).toBe(409);
    expect((await request(`/api/sessions/${sessionId}`)).json()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM published_beats WHERE session_id=$1', [sessionId])).rowCount).toBe(0);
  });

  it('keeps a published recording available through provider changes or removal without synthesizing again', async () => {
    const preview = await prepare(); await publish(preview.preparationId);
    const id = snapshot.history.at(-1).id;
    const original = (await request(`/api/sessions/${sessionId}/audio/${id}`)).json();
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, speechModel: 'a-different-model', speechVoiceId: 'a-different-voice', assetDir: directory });
    expect((await request(`/api/sessions/${sessionId}/audio/${id}`)).json()).toEqual(original);
    const posted = await request(`/api/sessions/${sessionId}/audio/${id}`, { commandId: randomUUID() });
    expect(posted.statusCode, posted.body).toBe(200); expect(posted.json()).toEqual(original);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed indexed private-media selectors without leaking database errors', async () => {
    const preview = await prepare(), path = draftPath();
    for (const suffix of ['/not-a-uuid/segments/0', `/${'a'.repeat(36)}/segments/0`, `/${preview.preparationId}/segments/-1`, `/${preview.preparationId}/segments/30`]) {
      const rejected = await request(path + suffix);
      expect([400, 404]).toContain(rejected.statusCode);
      expect(rejected.body).not.toMatch(/uuid|syntax|SELECT|postgres/i);
    }
  });

  it('serializes the same actor receipt key across two owned sessions before any duplicate speech work', async () => {
    const other = (await request('/api/sessions', { commandId: randomUUID() })).json().sessionId;
    const otherBeat = { ...snapshot.activeBeat, id: randomUUID(), sessionId: other, lockedSubmissions: [], selectedSubmissionIds: [], draft: { ...snapshot.activeBeat.draft, segments: [{ kind: 'narration', text: 'The other private saved narration.', recipientCharacterIds: [], delivery: 'neutral' }] }, sourceStateRevision: 0 };
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','draft_review',$3)", [otherBeat.id, other, otherBeat]);
    const commandId = randomUUID();
    const attempts = await Promise.all([
      request(draftPath(), { ...prepareBody(), commandId }),
      request(`/api/sessions/${other}/beats/${otherBeat.id}/draft-audio`, { commandId, expectedBeatRevision: otherBeat.revision, draftRevision: otherBeat.draftRevision, generation: otherBeat.generation }),
    ]);
    expect(attempts.map(value => value.statusCode).sort()).toEqual([200, 409]);
    const winner = attempts.find(value => value.statusCode === 200)!.json();
    expect(winner.status).toBe('ready');
    expect(synthesize).toHaveBeenCalledTimes(winner.manifest.segments.length);
    expect((await pool.query('SELECT 1 FROM draft_audio_preparations WHERE session_id=ANY($1)', [[sessionId, other]])).rowCount).toBe(1);
  });

  it('allows text-only fallback and rejects a stale or foreign selected preparation', async () => {
    const preview = await prepare();
    await beat('edit_script', { segments: [{ kind: 'narration', text: 'Changed after rehearsal.', delivery: 'neutral', recipientCharacterIds: [] }] });
    const body = { commandId: randomUUID(), type: 'publish_beat', ...beatFields(), expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.preparationId };
    expect((await request(`/api/sessions/${sessionId}/commands`, body)).statusCode).toBe(409);
    expect((await request(`/api/sessions/${sessionId}/commands`, { ...body, commandId: randomUUID(), audioPreparationId: randomUUID() })).statusCode).toBe(409);
    await publish();
    expect(snapshot.history.at(-1).textOnly).toBe(true);
  });

  it('blocks only a render of the current generation and permits a manually superseded saved draft', async () => {
    const current = snapshot.activeBeat;
    await pool.query("INSERT INTO generation_jobs(id,session_id,beat_id,snapshot_hash,generation,status,input,task) VALUES($1,$2,$3,'test',$4,'running','{}','render')", [randomUUID(), sessionId, current.id, current.generation]);
    expect((await request(draftPath(), prepareBody())).statusCode).toBe(409);
    await beat('edit_script', { segments: [{ kind: 'narration', text: 'Manual saved override.', delivery: 'neutral', recipientCharacterIds: [] }] });
    expect((await prepare()).segments[0].text).toBe('Manual saved override.');
  });

  it('checks credential revocation after a preparation completion waits for the session lock', async () => {
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const pending = request(draftPath(), prepareBody()).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      gate.resolve(audio()); await lockWait();
      const token = decodeURIComponent(host.slice(host.indexOf('=') + 1));
      await pool.query('UPDATE credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')]);
      await client.query('COMMIT');
      expect((await pending).statusCode).toBe(401);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('checks publication credentials after a real session lock wait before applying continuity', async () => {
    const body = { commandId: randomUUID(), type: 'publish_beat', ...beatFields(), expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: true };
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const pending = request(`/api/sessions/${sessionId}/commands`, body).then(value => value);
      await lockWait();
      const token = decodeURIComponent(host.slice(host.indexOf('=') + 1));
      await pool.query('UPDATE credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')]);
      await client.query('COMMIT');
      expect((await pending).statusCode).toBe(401);
      expect((await pool.query('SELECT 1 FROM published_beats WHERE session_id=$1', [sessionId])).rowCount).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('preserves the winning cache bytes and metadata when another writer installs during public synthesis', async () => {
    const savedSpeech = snapshot.activeBeat.draft.segments[0];
    const key = speechCacheKey({ sessionId, text: savedSpeech.text, provider: 'elevenlabs', model, voiceId, delivery: savedSpeech.delivery });
    await publish();
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const pending = request(`/api/sessions/${sessionId}/audio/${snapshot.history.at(-1).id}`, { commandId: randomUUID() }).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const winner = new Uint8Array([73, 68, 51, 5, 6, 7, 8]);
    await writeFile(join(directory, `${key}.mp3`), winner, { flag: 'wx' });
    await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',$3)", [key, sessionId, winner.byteLength]);
    gate.resolve(audio([73, 68, 51, 9]));
    expect((await pending).statusCode).toBe(200);
    expect(await readFile(join(directory, `${key}.mp3`))).toEqual(Buffer.from(winner));
    expect((await pool.query('SELECT byte_length FROM audio_assets WHERE id=$1', [key])).rows[0].byte_length).toBe(winner.byteLength);
  });

  it('reports actual first-clip progress and speech attempts before the second private clip completes', async () => {
    const texts = ['One 😀 saved line.', 'The second saved line.'];
    await beat('edit_script', { segments: texts.map(text => ({ kind: 'narration', text, delivery: 'neutral', recipientCharacterIds: [] })) });
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockResolvedValueOnce(audio()).mockImplementationOnce(() => gate.promise);
    const path = draftPath(), body = prepareBody();
    const pending = request(path, body).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 2);
    const running = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(running.speech.draft).toMatchObject({ status: 'preparing', completedSegments: 1, totalSegments: 2 });
    expect(running.progress).toContainEqual(expect.objectContaining({ kind: 'draft_audio', status: 'running', completedSegments: 1, totalSegments: 2, finishedAt: null }));
    expect(running.usage.speech).toMatchObject({ attempts: 2, succeeded: 1, pending: 1, characters: texts.reduce((count, text) => count + [...text].length, 0), cacheHits: 0, sharedHits: 0 });
    expect((await request(path, body)).json().status).toBe('preparing');
    expect((await request(`/api/sessions/${sessionId}/operations`)).json().usage).toEqual(running.usage);
    gate.resolve(audio());
    const ready = await pending; expect(ready.statusCode, ready.body).toBe(200);
    const finished = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(finished.speech.draft).toMatchObject({ status: 'ready', completedSegments: 2, totalSegments: 2 });
    expect(finished.usage.speech).toMatchObject({ attempts: 2, succeeded: 2, pending: 0, cacheHits: 0, sharedHits: 0 });
    await request(path, body); await request(ready.json().manifest.segments[0].url);
    expect((await request(`/api/sessions/${sessionId}/operations`)).json().usage).toEqual(finished.usage);
    await publish(ready.json().manifest.preparationId);
    const published = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(published.speech.published).toMatchObject({ status: 'ready', completedSegments: 2, totalSegments: 2 });
    expect(published.usage.speech).toEqual(finished.usage.speech);
  });

  it('reports public first-clip progress and leaves cached ready-manifest requests out of usage', async () => {
    await publish();
    const path = `/api/sessions/${sessionId}/audio/${snapshot.history.at(-1).id}`;
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockResolvedValueOnce(audio()).mockImplementationOnce(() => gate.promise);
    const pending = request(path, { commandId: randomUUID() }).then(value => value);
    await waitFor(async () => synthesize.mock.calls.length === 2);
    const running = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(running.speech.published).toMatchObject({ status: 'preparing', completedSegments: 1, totalSegments: 2 });
    expect(running.progress).toContainEqual(expect.objectContaining({ kind: 'published_audio', status: 'running', completedSegments: 1, totalSegments: 2, finishedAt: null }));
    gate.resolve(audio()); expect((await pending).statusCode).toBe(200);
    const finished = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(finished.speech.published).toMatchObject({ status: 'ready', completedSegments: 2, totalSegments: 2 });
    await request(path, { commandId: randomUUID() }); await request(path);
    expect((await request(`/api/sessions/${sessionId}/operations`)).json().usage).toEqual(finished.usage);
    expect(finished.usage.speech).toMatchObject({ attempts: 2, succeeded: 2, pending: 0, cacheHits: 0, sharedHits: 0 });
  });

  it('counts one adapter attempt and successful shared/cache fulfillment using Unicode code points', async () => {
    const input = { sessionId, beatId: snapshot.activeBeat.id, operationId: randomUUID(), text: 'A 😀 clip.', voiceProfileId: 'voice_narrator', delivery: 'neutral' as const };
    const options = { pool, provider: { synthesize }, model, voiceId, assetDir: directory };
    const gate = deferred<ReturnType<typeof audio>>(); synthesize.mockImplementationOnce(() => gate.promise);
    const first = cachedSpeech(options, input);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const shared = cachedSpeech(options, { ...input, operationId: randomUUID() });
    const running = (await request(`/api/sessions/${sessionId}/operations`)).json();
    expect(running.usage.speech).toMatchObject({ attempts: 1, pending: 1, sharedHits: 0, characters: [...input.text].length });
    gate.resolve(audio()); await Promise.all([first, shared]);
    await cachedSpeech(options, { ...input, operationId: randomUUID() });
    expect((await request(`/api/sessions/${sessionId}/operations`)).json().usage.speech).toEqual({ attempts: 1, succeeded: 1, failed: 0, pending: 0, interrupted: 0, characters: [...input.text].length, cacheHits: 1, sharedHits: 1 });
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('does not count failed shared promises or calls rejected before reaching a speech adapter as reuse', async () => {
    const input = { sessionId, beatId: snapshot.activeBeat.id, operationId: randomUUID(), text: 'A failed shared clip.', voiceProfileId: 'voice_narrator', delivery: 'neutral' as const };
    const options = { pool, provider: { synthesize }, model, voiceId, assetDir: directory };
    let fail!: (reason: Error) => void;
    const gate = new Promise<ReturnType<typeof audio>>((_done, reject) => { fail = reject; });
    synthesize.mockImplementationOnce(() => gate);
    const first = cachedSpeech(options, input);
    await waitFor(async () => synthesize.mock.calls.length === 1);
    const shared = cachedSpeech(options, { ...input, operationId: randomUUID() });
    const settled = Promise.allSettled([first, shared]);
    fail(new Error('Provider rejected its one request.')); await settled;
    await expect(cachedSpeech({ ...options, provider: undefined }, { ...input, text: 'An uncached disabled request.', operationId: randomUUID() })).rejects.toThrow();
    expect((await request(`/api/sessions/${sessionId}/operations`)).json().usage.speech).toMatchObject({ attempts: 1, failed: 1, pending: 0, cacheHits: 0, sharedHits: 0, characters: [...input.text].length });
  });

  it('finishes a recording when only progress telemetry writes fail and marks the usage gap', async () => {
    const name = `progress_failure_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id='${sessionId}' THEN RAISE EXCEPTION 'Progress telemetry unavailable'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE OF completed_segments ON draft_audio_preparations FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const ready = await prepare();
      expect(ready.segments).toHaveLength(2);
      const operations = (await request(`/api/sessions/${sessionId}/operations`)).json();
      expect(operations.speech.draft).toMatchObject({ status: 'ready', completedSegments: 2, totalSegments: 2 });
      expect(operations.usage).toMatchObject({ partial: true, speech: { attempts: 2, succeeded: 2, pending: 0 } });
      expect(synthesize).toHaveBeenCalledTimes(2);
      await publish(ready.preparationId);
      expect(snapshot.history.at(-1).textOnly).toBe(false);
      expect(synthesize).toHaveBeenCalledTimes(2);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON draft_audio_preparations`);
      await pool.query(`DROP FUNCTION ${name}()`);
    }
  });
});
