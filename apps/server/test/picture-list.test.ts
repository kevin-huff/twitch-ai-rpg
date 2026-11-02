import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ShelfPicturesSchema } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { shelfPictures } from '../src/picture-list';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'picture-list-test-host-credential';

interface Fields {
  purpose?: 'scene' | 'npc' | 'character' | 'card'; subject?: string; status?: 'making' | 'ready' | 'failed' | 'cancelled'; session?: string | null;
  owner?: string; hidden?: boolean; message?: string | null; beatId?: string | null; released?: boolean; showsBeatId?: string | null;
  moment?: boolean; sceneTitle?: string; shelfOnly?: boolean;
}

suite('shelfPictures', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let sessionId: string, otherSessionId: string, ownerId: string, sceneId: string, sceneTitle: string;
  let npcIds: string[], npcNames: string[], characterIds: string[], characterNames: string[];
  let clock: number;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  async function createSession(host: string) {
    const created = (await post('/api/sessions', { commandId: randomUUID() }, host)).json();
    return created.sessionId as string;
  }
  // Rows are made a second apart so the newest-first order is explicit.
  async function insert(fields: Fields = {}) {
    const id = randomUUID();
    const purpose = fields.purpose ?? 'scene';
    const status = fields.status ?? 'ready';
    const session = fields.session === undefined ? sessionId : fields.session;
    const moment = fields.moment
      ? JSON.stringify({ style: 'Painterly', model: 'flux-3-klein', scene: { title: fields.sceneTitle ?? 'The Moment Scene', description: 'A place.', place: 'Harbor' }, lines: [], cast: [], names: [] })
      : null;
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, hidden, prompt, width, height, provider, model, requested_by,
         file_hash, content_type, byte_length, message, beat_id, released_at, shows_beat_id, moment, shelf_only, created_at)
       VALUES($1,$2,$3,$4,$5,'picture-list-test',$6,$7,'A quiet harbor.',768,768,'fake','fake-image',$2,$8,$9,$10,$11,$12,
         CASE WHEN $13::boolean THEN now() + $17::int * interval '1 second' END, $14, $15, $16, now() + $17::int * interval '1 second')`,
      [id, fields.owner ?? ownerId, session, purpose, fields.subject ?? (purpose === 'scene' ? sceneId : npcIds[0]!), status, fields.hidden ?? false,
        status === 'ready' ? 'a'.repeat(64) : null, status === 'ready' ? 'image/jpeg' : null, status === 'ready' ? 1000 : null,
        fields.message ?? null, fields.beatId ?? null, fields.released ?? false, fields.showsBeatId ?? null, moment, fields.shelfOnly ?? false, clock++]);
    return id;
  }
  async function publishBeat(kind: 'action' | 'conversation', beatNumber: number, actionRoundNumber: number, text: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,$3,'published','{}')", [id, sessionId, kind]);
    await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,$3,$4)', [id, sessionId, beatNumber, {
      id, kind, beatNumber, actionRoundNumber, stateRevision: 1, publishedAt: new Date().toISOString(), rolls: [], outcomes: [], textOnly: true,
      segments: [{ id: `${id}-0`, kind: 'narration', text, speaker: null, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }],
    }]);
    return id;
  }
  async function openBeat() {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'conversation','draft_review','{}')", [id, sessionId]);
    return id;
  }
  async function list() {
    const client = await pool.connect();
    try { return await shelfPictures(client, sessionId); } finally { client.release(); }
  }
  const byId = async () => new Map((await list()).pictures.map(picture => [picture.imageId, picture]));
  const pin = (id: string | null) => pool.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [sessionId, id]);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    clock = 0;
    const host = cookie(await post('/api/auth/host', { token: hostToken }));
    sessionId = await createSession(host);
    otherSessionId = await createSession(host);
    const row = (await pool.query('SELECT owner_id, scene FROM sessions WHERE id=$1', [sessionId])).rows[0];
    ownerId = row.owner_id; sceneId = row.scene.id; sceneTitle = row.scene.title;
    const npcs = (await pool.query('SELECT id, data->>\'displayName\' AS name FROM npcs WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows;
    npcIds = npcs.map(npc => npc.id); npcNames = npcs.map(npc => npc.name);
    const characters = (await pool.query('SELECT id, data->>\'displayName\' AS name FROM characters WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows;
    characterIds = characters.map(character => character.id); characterNames = characters.map(character => character.name);
    expect(npcIds.length).toBeGreaterThan(1);
    expect(characterIds.length).toBeGreaterThan(1);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('is empty for a show with no pictures', async () => {
    expect(await list()).toEqual({ pictures: [] });
  });

  it('lists a place picture with its label, scene title, status and no beat', async () => {
    const id = await insert();
    const [picture] = (await list()).pictures;
    expect(picture).toMatchObject({
      imageId: id, kind: 'place', label: 'The place', scene: sceneTitle, status: 'ready', message: null,
      onStream: true, pinned: false, held: false, shelfOnly: false, beatId: null,
    });
    expect(picture!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it('labels a released action round, a published conversation beat and a held picture', async () => {
    const round = await publishBeat('action', 3, 2, 'The gate creaks open.');
    const talk = await publishBeat('conversation', 4, 0, 'The cellar door creaks.');
    const open = await openBeat();
    const action = await insert({ beatId: round, released: true, moment: true });
    const conversation = await insert({ beatId: talk, released: true, moment: true });
    const held = await insert({ beatId: open, moment: true, status: 'making' });
    const pictures = await byId();
    expect(pictures.get(action)).toMatchObject({ kind: 'beat', label: 'Action round 2', beatId: round, held: false, scene: 'The Moment Scene' });
    expect(pictures.get(conversation)).toMatchObject({ kind: 'beat', label: 'Beat 4', beatId: talk, held: false });
    expect(pictures.get(held)).toMatchObject({ kind: 'beat', label: 'The beat in progress', beatId: null, held: true, status: 'making', onStream: false });
  });

  it('names a held picture that failed before its beat was published by that beat, with the beat to draw again', async () => {
    const talk = await publishBeat('conversation', 1, 0, 'The lights die.');
    const round = await publishBeat('action', 2, 1, 'The gate holds.');
    const failedTalk = await insert({ beatId: talk, moment: true, status: 'failed', message: 'The picture could not be drawn.' });
    const failedRound = await insert({ beatId: round, moment: true, status: 'failed', message: 'The picture could not be drawn.' });
    const pictures = await byId();
    expect(pictures.get(failedTalk)).toMatchObject({ kind: 'beat', label: 'Beat 1', held: false, beatId: talk, status: 'failed', onStream: false });
    expect(pictures.get(failedRound)).toMatchObject({ kind: 'beat', label: 'Action round 1', held: false, beatId: round, status: 'failed' });
  });

  it('lists a shelf-only redraw as the beat it shows', async () => {
    const talk = await publishBeat('conversation', 6, 0, 'Rain falls.');
    const id = await insert({ showsBeatId: talk, moment: true, shelfOnly: true });
    expect((await byId()).get(id)).toMatchObject({ kind: 'beat', label: 'Beat 6', beatId: talk, shelfOnly: true, held: false });
  });

  it('keeps a failed picture with its message and leaves out cancelled pictures and another show\'s pictures', async () => {
    const failed = await insert({ status: 'failed', message: 'The picture service would not draw this scene.' });
    const making = await insert({ status: 'making', message: 'ignored while making' });
    const ready = await insert({ message: 'ignored while ready' });
    const cancelled = await insert({ status: 'cancelled' });
    const otherScene = (await pool.query('SELECT scene FROM sessions WHERE id=$1', [otherSessionId])).rows[0].scene.id as string;
    const foreign = await insert({ session: otherSessionId, subject: otherScene });
    const pictures = await byId();
    expect(pictures.get(failed)).toMatchObject({ status: 'failed', message: 'The picture service would not draw this scene.' });
    expect(pictures.get(making)).toMatchObject({ status: 'making', message: null });
    expect(pictures.get(ready)).toMatchObject({ status: 'ready', message: null });
    expect(pictures.has(cancelled)).toBe(false);
    expect(pictures.has(foreign)).toBe(false);
    expect(pictures.size).toBe(3);
  });

  it('lists non-player character portraits, and a library portrait a character uses, but not unused library portraits', async () => {
    const npcPortrait = await insert({ purpose: 'npc', subject: npcIds[1]! });
    const library = await insert({ purpose: 'card', subject: 'library-subject', session: null });
    const unused = await insert({ purpose: 'npc', subject: 'library-unused', session: null });
    const strangers = await insert({ purpose: 'npc', subject: 'library-other-owner', session: null, owner: `somebody-else-${randomUUID()}` });
    await pool.query("UPDATE characters SET data = jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2", [sessionId, characterIds[0], library]);
    const pictures = await byId();
    expect(pictures.get(npcPortrait)).toMatchObject({ kind: 'portrait', label: `Portrait of ${npcNames[1]}`, scene: null, beatId: null, held: false, shelfOnly: false });
    expect(pictures.get(library)).toMatchObject({ kind: 'portrait', label: `Portrait of ${characterNames[0]}`, scene: null });
    expect(pictures.has(unused)).toBe(false);
    expect(pictures.has(strangers)).toBe(false);
  });

  it('leaves out a held picture whose beat was abandoned', async () => {
    const open = await openBeat();
    const held = await insert({ beatId: open, moment: true, status: 'making' });
    expect((await byId()).has(held)).toBe(true);
    await pool.query("UPDATE beats SET phase='aborted' WHERE id=$1", [open]);
    expect((await byId()).has(held)).toBe(false);
  });

  it('labels a portrait nobody uses as A portrait', async () => {
    const id = await insert({ purpose: 'npc', subject: 'no-such-person' });
    expect((await byId()).get(id)).toMatchObject({ kind: 'portrait', label: 'A portrait' });
  });

  it('puts the newest scene picture on stream until one is pinned, then only the pinned picture', async () => {
    const older = await insert();
    const newer = await insert();
    const portrait = await insert({ purpose: 'npc', subject: npcIds[0]! });
    let pictures = await byId();
    expect([...pictures.values()].filter(picture => picture.onStream).map(picture => picture.imageId)).toEqual([newer]);
    expect([...pictures.values()].some(picture => picture.pinned)).toBe(false);

    await pin(older);
    pictures = await byId();
    expect([...pictures.values()].filter(picture => picture.onStream).map(picture => picture.imageId)).toEqual([older]);
    expect(pictures.get(older)).toMatchObject({ pinned: true, onStream: true });
    expect(pictures.get(newer)).toMatchObject({ pinned: false, onStream: false });

    await pin(portrait);
    pictures = await byId();
    expect([...pictures.values()].filter(picture => picture.onStream).map(picture => picture.imageId)).toEqual([portrait]);
    expect(pictures.get(portrait)).toMatchObject({ pinned: true, onStream: true });

    await pin(null);
    expect((await byId()).get(newer)).toMatchObject({ onStream: true, pinned: false });
  });

  it('does not put a pinned picture on stream while it is not ready', async () => {
    const shown = await insert();
    const drawing = await insert({ status: 'making' });
    await pin(drawing);
    const pictures = await byId();
    expect(pictures.get(drawing)).toMatchObject({ pinned: true, onStream: false });
    expect(pictures.get(shown)!.onStream).toBe(true);
  });

  it('names the scene a picture was drawn in from the scene changes', async () => {
    const first = await insert();
    const secondId = randomUUID();
    await pool.query(
      'INSERT INTO audit_events(id, session_id, actor_id, command_id, kind, data) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), sessionId, ownerId, randomUUID(), 'change_scene', { before: { scene: { id: sceneId, title: sceneTitle } }, after: { scene: { id: secondId, title: 'The Cellar' } } }]);
    await pool.query("UPDATE sessions SET scene = scene || jsonb_build_object('id', $2::text, 'title', 'The Cellar') WHERE id=$1", [sessionId, secondId]);
    const second = await insert({ subject: secondId });
    const pictures = await byId();
    expect(pictures.get(first)).toMatchObject({ scene: sceneTitle, onStream: false });
    expect(pictures.get(second)).toMatchObject({ scene: 'The Cellar', onStream: true });
  });

  it('lists newest first and parses with the schema', async () => {
    const a = await insert();
    const b = await insert({ purpose: 'npc', subject: npcIds[0]! });
    const c = await insert({ status: 'making' });
    const d = await insert({ status: 'failed', message: 'It failed.' });
    const result = await list();
    expect(result.pictures.map(picture => picture.imageId)).toEqual([d, c, b, a]);
    expect(ShelfPicturesSchema.safeParse(result).success).toBe(true);
  });

  it('breaks a tie in time by the larger id first', async () => {
    const ids = [await insert(), await insert()];
    await pool.query("UPDATE images SET created_at = '2026-10-31T00:00:00Z' WHERE id = ANY($1::uuid[])", [ids]);
    expect((await list()).pictures.map(picture => picture.imageId)).toEqual([...ids].sort().reverse());
  });
});
