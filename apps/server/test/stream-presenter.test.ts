import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';
import { PlaybackSnapshotSchema } from '../../../packages/contracts/src/playback';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const PERSONAL_MESSAGE = 'This stream view can listen but cannot present the show audio.';

suite('stream presenter guard and producer audit attribution', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let host: string;
  let sessionId: string;
  let characterId: string;
  const request = (path: string, payload?: object, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { cookie: credential, origin }, ...(payload === undefined ? {} : { payload }) });
  const claim = (credential: string, extra: object = {}) => request(`/api/sessions/${sessionId}/playback/presenter`, { commandId: randomUUID(), expectedRevision: 0, type: 'claim', clientId: randomUUID(), ...extra }, credential);

  async function streamCredential(subject: 'show' | 'player') {
    const linkId = randomUUID();
    const token = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO stream_links(id,session_id,subject,character_id,label,can_present,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '90 days')`,
      [linkId, sessionId, subject, subject === 'player' ? characterId : null, `${subject} link`, subject === 'show', hash(randomBytes(16).toString('hex'))],
    );
    await pool.query(
      `INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,stream_link_id,expires_at) VALUES($1,$2,'stage',$3,NULL,$4,now()+interval '12 hours')`,
      [hash(token), `stream:${linkId}`, sessionId, linkId],
    );
    return `rpg_session=${token}`;
  }
  async function producerCredential() {
    const grantId = randomUUID();
    const token = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO producer_grants(id,owner_id,label,token_hash,expires_at) VALUES($1,$2,'Test producer',$3,now()+interval '30 days')`,
      [grantId, hash(hostToken), hash(randomBytes(16).toString('hex'))],
    );
    await pool.query(
      `INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,producer_grant_id,expires_at) VALUES($1,$2,'producer',NULL,NULL,$3,now()+interval '12 hours')`,
      [hash(token), hash(hostToken), grantId],
    );
    return { grantId, credential: `rpg_session=${token}` };
  }

  beforeEach(async () => {
    hostToken = randomBytes(24).toString('hex');
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    host = String(signIn.headers['set-cookie']).split(';')[0]!;
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    sessionId = created.json().sessionId;
    characterId = (await request(`/api/sessions/${sessionId}`)).json().characterDetails[0].id;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('refuses a personal stream view as presenter but still lets it read playback', async () => {
    const personal = await streamCredential('player');
    const refused = await claim(personal);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error?.message ?? refused.json().message).toBe(PERSONAL_MESSAGE);
    expect((await request(`/api/sessions/${sessionId}/playback`, undefined, personal)).statusCode).toBe(200);
    expect((await request(`/api/sessions/${sessionId}/playback`)).json().presenter.available).toBe(false);
  });

  it('lets a show link claim and renew the presenter lease', async () => {
    const show = await streamCredential('show');
    const clientId = randomUUID();
    const claimed = await claim(show, { clientId });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const leaseId = claimed.json().leaseId as string;
    expect(leaseId).toMatch(/^[a-f0-9-]{36}$/);
    const renewed = await request(`/api/sessions/${sessionId}/playback/presenter`, { commandId: randomUUID(), clientId, leaseId, type: 'renew', renewalSequence: 1 }, show);
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json().snapshot.presenter.available).toBe(true);
  });

  const readPresenter = async () => {
    const response = await request(`/api/sessions/${sessionId}/playback`);
    expect(response.statusCode, response.body).toBe(200);
    expect(PlaybackSnapshotSchema.safeParse(response.json()).success).toBe(true);
    return response.json().presenter;
  };

  it('reports presenter source null when nobody presents', async () => {
    const presenter = await readPresenter();
    expect(presenter.available).toBe(false);
    expect(presenter.source).toBeNull();
  });

  it('reports presenter source show_link when a main show link holds the lease', async () => {
    const claimed = await claim(await streamCredential('show'));
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(PlaybackSnapshotSchema.safeParse(claimed.json().snapshot).success).toBe(true);
    expect(claimed.json().snapshot.presenter.source).toBe('show_link');
    const presenter = await readPresenter();
    expect(presenter.source).toBe('show_link');
    expect(JSON.stringify(presenter)).not.toContain('leaseId');
  });

  it('reports presenter source preview when a host or producer tab holds the lease', async () => {
    const claimed = await claim(host);
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().snapshot.presenter.source).toBe('preview');
    expect((await readPresenter()).source).toBe('preview');
  });

  it('reports presenter source preview for a producer credential', async () => {
    const { credential } = await producerCredential();
    const claimed = await claim(credential);
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect((await readPresenter()).source).toBe('preview');
  });

  it('still lets the host claim the presenter lease', async () => {
    const claimed = await claim(host);
    expect(claimed.statusCode, claimed.body).toBe(200);
  });

  it('records the producer grant on audit rows for producer actions and NULL for the host', async () => {
    const { grantId, credential } = await producerCredential();
    const state = (await request(`/api/sessions/${sessionId}`)).json();
    const status = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'set_status', status: 'live', expectedStateRevision: state.session.stateRevision });
    expect(status.statusCode, status.body).toBe(200);
    const snapshot = status.json().snapshot;
    const opened = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch }, credential);
    expect(opened.statusCode, opened.body).toBe(200);
    const rows = await pool.query('SELECT kind,actor_id,producer_grant_id FROM audit_events WHERE session_id=$1 AND kind IN ($2,$3)', [sessionId, 'set_status', 'open_beat']);
    const byKind = Object.fromEntries(rows.rows.map(row => [row.kind, row]));
    expect(byKind.open_beat.producer_grant_id).toBe(grantId);
    expect(byKind.open_beat.actor_id).toBe(hash(hostToken));
    expect(byKind.set_status.producer_grant_id).toBeNull();
  });
});
