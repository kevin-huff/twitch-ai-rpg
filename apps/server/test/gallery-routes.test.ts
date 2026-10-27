import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorSnapshot, GalleryStatus } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { fakeImageBytes } from '../src/fake-images';
import { GALLERY_CSP } from '../src/gallery-routes';
import { storeImage } from '../src/image-files';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const MISSING_TITLE = '<title>Gallery not available</title>';
const NOT_ENDED = 'The gallery opens once the show has ended.';
const OFF = 'The gallery is off. Turn it on first.';
const DIRECTOR_ONLY = 'Only the director can change the gallery.';

suite('gallery director route and public serving', () => {
  let pool: ReturnType<typeof createPool>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let assetDir: string;
  let host: string;
  let producer: string;
  const sessionIds: string[] = [];
  const invites = new Map<string, { player: string; stage: string }>();
  const cookiePair = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;

  const call = (url: string, payload?: Record<string, unknown>, credential: string = host) => app.inject({
    method: payload === undefined ? 'GET' : 'POST',
    url,
    headers: { origin, ...(credential ? { cookie: credential } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });
  const post = (id: string, action: unknown, credential: string = host) => call(`/api/sessions/${id}/gallery`, { action } as Record<string, unknown>, credential);
  const director = async (id: string) => (await call(`/api/sessions/${id}?view=director`)).json() as DirectorSnapshot;
  const setStatus = async (id: string, status: string) => {
    const response = await call(`/api/sessions/${id}/commands`, { commandId: randomUUID(), type: 'set_status', status, expectedStateRevision: (await director(id)).session.stateRevision });
    expect(response.statusCode, response.body).toBe(200);
  };
  const pathOf = (url: string) => new URL(url).pathname;

  async function newShow(title: string, ended: boolean) {
    const response = await call('/api/sessions', { commandId: randomUUID(), title });
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json();
    const id = created.sessionId as string;
    sessionIds.push(id);
    const tokens: Record<string, string> = {};
    for (const role of ['player', 'stage']) {
      const token = created.invites.find((invite: { role: string }) => invite.role === role).token as string;
      tokens[role] = cookiePair(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } }));
    }
    invites.set(id, { player: tokens.player!, stage: tokens.stage! });
    if (ended) { await setStatus(id, 'live'); await setStatus(id, 'ended'); }
    return id;
  }

  async function addPictures(id: string, count: number) {
    const row = (await pool.query("SELECT owner_id, scene->>'id' AS scene_id FROM sessions WHERE id=$1", [id])).rows[0];
    const files: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const prompt = `A lantern-lit harbor ${index} for ${id}`;
      const stored = await storeImage(assetDir, fakeImageBytes({ prompt, width: 64, height: 64 }));
      const pictureId = randomUUID();
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model,
           requested_by, file_hash, content_type, byte_length, created_at)
         VALUES($1,$2,$3,'scene',$4,'gallery-routes-test','ready',$5,64,64,'fake','fake-image',$2,$6,$7,$8,$9)`,
        [pictureId, row.owner_id, id, row.scene_id, prompt, stored.fileHash, stored.contentType, stored.byteLength, new Date(Date.UTC(2026, 9, 25, 2, index))]);
      files.push(`${pictureId}.${stored.contentType === 'image/png' ? 'png' : stored.contentType === 'image/webp' ? 'webp' : 'jpg'}`);
    }
    return files;
  }

  async function events(id: string) {
    return (await pool.query("SELECT kind, data FROM audit_events WHERE session_id=$1 AND kind LIKE 'gallery.%' ORDER BY sequence", [id])).rows as { kind: string; data: unknown }[];
  }

  function expectMissing(response: { statusCode: number; body: string; headers: Record<string, unknown> }) {
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain(MISSING_TITLE);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe(GALLERY_CSP);
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-gallery-routes-'));
    const hostToken = `gallery-routes-host-${randomUUID()}`;
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir });
    host = cookiePair(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const grant = await call('/api/producers', { commandId: randomUUID(), label: 'Gallery producer' });
    expect(grant.statusCode, grant.body).toBe(200);
    const signedIn = await app.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token: grant.json().token } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    producer = cookiePair(signedIn);
  });
  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (sessionIds.length) await pool.query('DELETE FROM galleries WHERE session_id = ANY($1)', [sessionIds]);
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('turns away a missing credential, player and stage seats, another host and a bad body', async () => {
    const id = await newShow('Gallery access', true);
    const seats = invites.get(id)!;
    expect((await post(id, 'on', '')).statusCode).toBe(401);
    for (const credential of [seats.player, seats.stage]) {
      const refused = await post(id, 'on', credential);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'forbidden', message: DIRECTOR_ONLY });
    }
    for (const body of ['sideways', undefined, 3]) expect((await post(id, body)).statusCode).toBe(400);
    expect((await call(`/api/sessions/${id}/gallery`, { action: 'on', extra: true })).statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM galleries WHERE session_id=$1', [id])).rowCount).toBe(0);

    const foreign = await newShow('Gallery foreign', true);
    await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [foreign, 'foreign-host']);
    expect((await post(foreign, 'on')).statusCode).toBe(404);
    expect((await pool.query('SELECT 1 FROM galleries WHERE session_id=$1', [foreign])).rowCount).toBe(0);
  });

  it('lets a producer manage the gallery', async () => {
    const id = await newShow('Gallery producer show', true);
    const response = await post(id, 'on', producer);
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as GalleryStatus).state).toBe('on');
    expect((await post(id, 'off', producer)).json()).toMatchObject({ state: 'off' });
  });

  it('refuses to turn on before the show has ended', async () => {
    const id = await newShow('Gallery too early', false);
    for (const status of ['lobby', 'live']) {
      if (status === 'live') await setStatus(id, 'live');
      const refused = await post(id, 'on');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: NOT_ENDED });
    }
    expect((await pool.query('SELECT 1 FROM galleries WHERE session_id=$1', [id])).rowCount).toBe(0);
    expect((await director(id)).gallery?.state).toBe('closed');
  });

  it('runs every action after the show has ended and records one event for each, without the link in any of them', async () => {
    const id = await newShow('Gallery full flow', true);
    const files = await addPictures(id, 2);
    const slugs: string[] = [];

    // on
    const on = await post(id, 'on');
    expect(on.statusCode, on.body).toBe(200);
    const onStatus = on.json() as GalleryStatus;
    expect(onStatus).toMatchObject({ state: 'on', listed: false, pictures: 2, pending: 0, message: null });
    expect(onStatus.url).toMatch(/^http:\/\/localhost:3000\/gallery\/[A-Za-z0-9_-]{43}\/$/);
    expect(onStatus.writtenAt).not.toBeNull();
    slugs.push(pathOf(onStatus.url!).split('/')[2]!);
    const firstPath = pathOf(onStatus.url!);
    const page = await call(firstPath, undefined, '');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toBe(GALLERY_CSP);
    expect(page.headers['cache-control']).toBe('public, max-age=60');
    expect(String(page.headers['content-type'])).toContain('text/html');
    for (const file of files) {
      expect(page.body).toContain(`${firstPath}p/${file}`);
      const picture = await call(`${firstPath}p/${file}`, undefined, '');
      expect(picture.statusCode, file).toBe(200);
      expect(picture.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect((await call('/gallery/', undefined, '')).body).not.toContain(slugs[0]!);

    // list
    const listed = await post(id, 'list');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({ state: 'on', listed: true });
    const list = await call('/gallery/', undefined, '');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(`href="${firstPath}"`);

    // unlist
    const unlisted = await post(id, 'unlist');
    expect(unlisted.statusCode, unlisted.body).toBe(200);
    expect(unlisted.json()).toMatchObject({ state: 'on', listed: false });
    expect((await call('/gallery/', undefined, '')).body).not.toContain(slugs[0]!);
    expect((await call(firstPath, undefined, '')).statusCode).toBe(200);

    // rewrite
    const before = onStatus.writtenAt!;
    const rewritten = await post(id, 'rewrite');
    expect(rewritten.statusCode, rewritten.body).toBe(200);
    expect(rewritten.json()).toMatchObject({ state: 'on', pictures: 2, message: null });
    expect(Date.parse((rewritten.json() as GalleryStatus).writtenAt!)).toBeGreaterThanOrEqual(Date.parse(before));

    // new link
    const replaced = await post(id, 'new_link');
    expect(replaced.statusCode, replaced.body).toBe(200);
    const replacedStatus = replaced.json() as GalleryStatus;
    expect(replacedStatus.state).toBe('on');
    expect(replacedStatus.url).not.toBe(onStatus.url);
    expect(replacedStatus.pictures).toBe(2);
    slugs.push(pathOf(replacedStatus.url!).split('/')[2]!);
    const secondPath = pathOf(replacedStatus.url!);
    expectMissing(await call(firstPath, undefined, ''));
    expectMissing(await call(`${firstPath}p/${files[0]}`, undefined, ''));
    const fresh = await call(secondPath, undefined, '');
    expect(fresh.statusCode).toBe(200);
    for (const file of files) expect(fresh.body).toContain(`${secondPath}p/${file}`);

    // turn off: both links stay dead and the list shows neither
    expect((await post(id, 'off')).statusCode).toBe(200);
    const off = await director(id);
    expect(off.gallery).toMatchObject({ state: 'off', url: null, pictures: 0 });
    expectMissing(await call(secondPath, undefined, ''));
    expectMissing(await call(`${secondPath}p/${files[0]}`, undefined, ''));
    const finalList = await call('/gallery/', undefined, '');
    expect(finalList.statusCode).toBe(200);
    for (const slug of slugs) expect(finalList.body).not.toContain(slug);

    // one event per action plus one gallery.written per write, with no link inside
    const recorded = await events(id);
    expect(recorded.map(event => event.kind)).toEqual([
      'gallery.on', 'gallery.written', 'gallery.listed', 'gallery.unlisted', 'gallery.rewritten', 'gallery.written',
      'gallery.new_link', 'gallery.written', 'gallery.off',
    ]);
    for (const event of recorded.filter(item => item.kind === 'gallery.written')) expect(event.data).toEqual({ pictures: 2, failed: false });
    for (const event of recorded) for (const slug of slugs) expect(JSON.stringify(event.data), event.kind).not.toContain(slug);
  });

  it('answers 409 to every other action while the gallery is off', async () => {
    const id = await newShow('Gallery stays off', true);
    for (const action of ['off', 'new_link', 'list', 'unlist', 'rewrite']) {
      const refused = await post(id, action);
      expect(refused.statusCode, action).toBe(409);
      expect(refused.json(), action).toMatchObject({ code: 'conflict', message: OFF });
    }
    expect((await events(id))).toEqual([]);
    expect((await pool.query('SELECT 1 FROM galleries WHERE session_id=$1', [id])).rowCount).toBe(0);
  });
});
