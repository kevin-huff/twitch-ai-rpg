import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PlaybackSnapshotSchema, ShowAudioHolderResponseSchema, type AudioManifest } from '@rpg/contracts';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const OBS_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OBS/31.0.2';
const PLAIN_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FORBIDDEN = 'Only the director can see or stop the show audio.';
const MOVED = 'The show audio moved to another page. Check who has it now.';
const STOPPED = 'This page was stopped from the director page. Reload it to play the show audio here again.';
const message = (response: { json(): any }) => response.json().error?.message ?? response.json().message;

suite('show audio holder and stop', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let host: string;
  let stage: string;
  let player: string;
  let sessionId: string;
  let characterId: string;
  let mainShow: string;
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: object, credential = host, agent?: string) => app.inject({
    method: payload === undefined ? 'GET' : 'POST', url: `/api/sessions/${sessionId}/playback${path}`,
    headers: { cookie: credential, origin, ...(agent ? { 'user-agent': agent } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  const revision = async () => (await request('')).json().revision as number;
  async function claim(credential: string, agent?: string, clientId = randomUUID()) {
    const response = await request('/presenter', { commandId: randomUUID(), expectedRevision: await revision(), type: 'claim', clientId }, credential, agent);
    return { response, clientId, leaseId: response.statusCode === 200 ? response.json().leaseId as string : '' };
  }
  async function readHolder(credential = host) {
    const response = await request('/holder', undefined, credential);
    expect(response.statusCode, response.body).toBe(200);
    return ShowAudioHolderResponseSchema.parse(response.json()).holder;
  }
  const stop = (holderId: string, commandId = randomUUID(), credential = host) => request('/holder/stop', { commandId, holderId }, credential);
  async function streamCredential(subject: 'show' | 'player', label: string) {
    const linkId = randomUUID();
    const token = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO stream_links(id,session_id,subject,character_id,label,can_present,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '90 days')`,
      [linkId, sessionId, subject, subject === 'player' ? characterId : null, label, subject === 'show', hash(randomBytes(16).toString('hex'))],
    );
    await pool.query(
      `INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,stream_link_id,expires_at) VALUES($1,$2,'stage',$3,NULL,$4,now()+interval '12 hours')`,
      [hash(token), `stream:${linkId}`, sessionId, linkId],
    );
    return `rpg_session=${token}`;
  }
  async function seedPlayableBeat() {
    const id = randomUUID();
    const segments = [{ id: randomUUID(), kind: 'narration', text: 'The lights come up.', speaker: null, voiceProfileId: null, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], ttsEnabled: true }];
    const publication = { id, kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 1, publishedAt: new Date().toISOString(), segments, rolls: [], outcomes: [], textOnly: true };
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','published',$3)", [id, sessionId, {}]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,1,$3)', [id, sessionId, publication]);
    const assetId = createHash('sha256').update(id).digest('hex');
    const manifest: AudioManifest = { beatId: id, segments: [{ id: segments[0]!.id, text: segments[0]!.text, speaker: 'Narrator', voiceProfileId: 'voice_narrator', url: `/api/sessions/${sessionId}/audio/assets/${assetId}` }] };
    await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',4)", [assetId, sessionId]);
    await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest) VALUES($1,$2,'original','ready',$3,clock_timestamp(),$4)", [sessionId, id, randomUUID(), manifest]);
    return id;
  }

  beforeEach(async () => {
    hostToken = `holder-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const creation = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: randomUUID() } });
    expect(creation.statusCode, creation.body).toBe(200);
    sessionId = creation.json().sessionId;
    for (const role of ['stage', 'player']) {
      const token = creation.json().invites.find((invite: any) => invite.role === role).token;
      const credential = cookie(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } }));
      if (role === 'stage') stage = credential; else player = credential;
    }
    characterId = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { origin, cookie: host } })).json().characterDetails[0].id;
    await pool.query("UPDATE sessions SET title='Night at the Diner' WHERE id=$1", [sessionId]);
    mainShow = await streamCredential('show', 'Main show');
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('says nobody holds the show audio before any claim', async () => {
    expect(await readHolder()).toBeNull();
    expect((await request('/holder')).json()).toEqual({ holder: null });
  });

  it('records the Main show link in OBS with the show title and claim time, and only five keys', async () => {
    const before = Date.now();
    const { response, leaseId } = await claim(mainShow, OBS_AGENT);
    expect(response.statusCode, response.body).toBe(200);
    const raw = (await request('/holder')).json();
    expect(Object.keys(raw.holder).sort()).toEqual(['browser', 'claimedAt', 'holderId', 'label', 'showTitle']);
    const holder = await readHolder();
    expect(holder).toMatchObject({ holderId: leaseId, label: 'Main show', showTitle: 'Night at the Diner', browser: 'obs' });
    const claimedAt = Date.parse(holder!.claimedAt!);
    expect(claimedAt).toBeGreaterThanOrEqual(before - 5000);
    expect(claimedAt).toBeLessThanOrEqual(Date.now() + 5000);
    const stored = (await pool.query('SELECT * FROM session_playback WHERE session_id=$1', [sessionId])).rows[0];
    expect(stored.presenter_agent).toBe('obs');
    expect(JSON.stringify(stored)).not.toContain('Mozilla');
    expect(JSON.stringify(stored)).not.toContain('127.0.0.1');
    expect(JSON.stringify(raw)).not.toContain('Mozilla');
  });

  it('records a cast member link in a regular browser, and a host tab as the preview page', async () => {
    const castLink = await streamCredential('show', "Ada's link");
    const cast = await claim(castLink, PLAIN_AGENT);
    expect(cast.response.statusCode, cast.response.body).toBe(200);
    expect(await readHolder()).toMatchObject({ label: "Ada's link", browser: 'browser' });
    expect((await stop(cast.leaseId)).statusCode).toBe(200);
    const preview = await claim(host);
    expect(preview.response.statusCode, preview.response.body).toBe(200);
    expect(await readHolder()).toMatchObject({ label: 'Preview page', browser: 'browser' });
  });

  it('labels a stage page without a link as the stream page', async () => {
    const { response } = await claim(stage, OBS_AGENT);
    expect(response.statusCode, response.body).toBe(200);
    expect(await readHolder()).toMatchObject({ label: 'Stream page', browser: 'obs' });
  });

  it('uses plain stand-ins for a claim made before the update', async () => {
    const { leaseId } = await claim(mainShow, OBS_AGENT);
    await pool.query('UPDATE session_playback SET presenter_label=NULL,presenter_show_title=NULL,presenter_agent=NULL,presenter_claimed_at_ms=NULL WHERE session_id=$1', [sessionId]);
    expect(await readHolder()).toEqual({ holderId: leaseId, label: 'A page opened before this update', showTitle: 'Night at the Diner', browser: 'unknown', claimedAt: null });
  });

  it('refuses the holder and stop routes to players and stream pages', async () => {
    const { leaseId } = await claim(mainShow, OBS_AGENT);
    for (const credential of [player, stage, mainShow]) {
      const read = await request('/holder', undefined, credential);
      expect(read.statusCode, read.body).toBe(403);
      expect(message(read)).toBe(FORBIDDEN);
      const stopped = await stop(leaseId, randomUUID(), credential);
      expect(stopped.statusCode, stopped.body).toBe(403);
      expect(message(stopped)).toBe(FORBIDDEN);
    }
    expect((await readHolder())?.holderId).toBe(leaseId);
  });

  it('stops the holder, pauses playing narration, and repeats the same answer for the same command', async () => {
    const beatId = await seedPlayableBeat();
    const { leaseId } = await claim(mainShow, OBS_AGENT);
    const started = await request('/commands', { commandId: randomUUID(), expectedRevision: await revision(), type: 'start', beatId });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().snapshot.status).toBe('playing');
    const commandId = randomUUID();
    const stopped = await stop(leaseId, commandId);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toEqual({ holder: null });
    expect(await readHolder()).toBeNull();
    const playback = PlaybackSnapshotSchema.parse((await request('')).json());
    expect(playback.presenter.available).toBe(false);
    expect(playback.status).toBe('paused');
    const stored = (await pool.query('SELECT presenter_label,presenter_show_title,presenter_agent,presenter_claimed_at_ms FROM session_playback WHERE session_id=$1', [sessionId])).rows[0];
    expect(stored).toEqual({ presenter_label: null, presenter_show_title: null, presenter_agent: null, presenter_claimed_at_ms: null });
    const repeated = await stop(leaseId, commandId);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toEqual({ holder: null });
    const reused = await stop(randomUUID(), commandId);
    expect(reused.statusCode).toBe(409);
  });

  it('refuses a stale stop when the show audio moved to another page', async () => {
    const first = await claim(mainShow, OBS_AGENT);
    expect((await stop(randomUUID())).statusCode).toBe(409);
    expect(message(await stop(randomUUID()))).toBe(MOVED);
    expect((await stop(first.leaseId)).statusCode).toBe(200);
    const second = await claim(mainShow, OBS_AGENT);
    const stale = await stop(first.leaseId);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(message(stale)).toBe(MOVED);
    expect((await readHolder())?.holderId).toBe(second.leaseId);
    expect(message(await stop(first.leaseId))).toBe(MOVED);
  });

  it('refuses the stopped page instance but lets another page on the same link claim', async () => {
    const first = await claim(mainShow, PLAIN_AGENT);
    expect((await stop(first.leaseId)).statusCode).toBe(200);
    const renew = await request('/presenter', { commandId: randomUUID(), clientId: first.clientId, leaseId: first.leaseId, type: 'renew', renewalSequence: 1 }, mainShow);
    expect(renew.statusCode, renew.body).toBe(409);
    const again = await claim(mainShow, PLAIN_AGENT, first.clientId);
    expect(again.response.statusCode, again.response.body).toBe(409);
    expect(message(again.response)).toBe(STOPPED);
    expect(await readHolder()).toBeNull();
    const fresh = await claim(mainShow, OBS_AGENT);
    expect(fresh.response.statusCode, fresh.response.body).toBe(200);
    expect(await readHolder()).toMatchObject({ holderId: fresh.leaseId, label: 'Main show', browser: 'obs' });
  });

  it('keeps the shared playback state exactly as before', async () => {
    const idle = (await request('')).json();
    expect(PlaybackSnapshotSchema.safeParse(idle).success).toBe(true);
    const { response } = await claim(mainShow, OBS_AGENT);
    expect(PlaybackSnapshotSchema.safeParse(response.json().snapshot).success).toBe(true);
    for (const credential of [host, stage, player, mainShow]) {
      const read = await request('', undefined, credential);
      expect(read.statusCode, read.body).toBe(200);
      const body = read.json();
      expect(PlaybackSnapshotSchema.safeParse(body).success).toBe(true);
      expect(Object.keys(body).sort()).toEqual(Object.keys(idle).sort());
      expect(Object.keys(body.presenter).sort()).toEqual(['available', 'leaseExpiresAtMs', 'source']);
      expect(JSON.stringify(body)).not.toMatch(/Main show|Night at the Diner|"obs"|claimedAt/);
    }
  });

  it('says nobody holds the show audio once the claim runs out', async () => {
    await claim(mainShow, OBS_AGENT);
    await pool.query('UPDATE session_playback SET presenter_expires_at_ms=$2 WHERE session_id=$1', [sessionId, Date.now() - 1000]);
    expect(await readHolder()).toBeNull();
    const stored = (await pool.query('SELECT presenter_lease_id,presenter_label FROM session_playback WHERE session_id=$1', [sessionId])).rows[0];
    expect(stored).toEqual({ presenter_lease_id: null, presenter_label: null });
  });
});
