import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { hourlyLimitMessage, PICTURE_MESSAGES } from '../src/picture-limits';
import { actionPictureView, imageVisibleTo, lastBeatInScene, pinnedPictureView, portraitJobsView, scenePictureView, type ImageRow } from '../src/picture-views';
import type { Actor } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'picture-views-test-host-credential';

type Fields = Partial<Pick<ImageRow, 'owner_id' | 'session_id' | 'builder_id' | 'purpose' | 'subject_id' | 'attach' | 'status' | 'hidden' | 'message' | 'beat_id'>> & { released?: boolean | number; finished?: number; moment?: boolean; shelf?: boolean; showsBeat?: string };

suite('picture views and visibility', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let sessionId: string, ownerId: string, sceneId: string, otherSessionId: string;
  let characterIds: string[], npcIds: string[];
  let clock: number, beatCounter: number;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  async function createSession(host: string) {
    const created = (await post('/api/sessions', { commandId: randomUUID() }, host)).json();
    const row = (await pool.query('SELECT owner_id, scene FROM sessions WHERE id=$1', [created.sessionId])).rows[0];
    return { id: created.sessionId as string, ownerId: row.owner_id as string, sceneId: row.scene.id as string };
  }
  // Rows are created a second apart so the newest-first ordering is explicit.
  async function insert(fields: Fields = {}) {
    const id = randomUUID();
    const purpose = fields.purpose ?? 'scene';
    const status = fields.status ?? 'ready';
    // released: true releases the row when it was made, a number releases it that many seconds from now.
    const releasedAt = fields.released === true ? clock : typeof fields.released === 'number' ? fields.released : null;
    // finished is how many seconds from now the picture finished; left out, finished_at stays empty.
    const finishedAt = typeof fields.finished === 'number' ? fields.finished : null;
    const row = { owner_id: ownerId, session_id: sessionId, builder_id: null, subject_id: purpose === 'scene' ? sceneId : npcIds[0]!, attach: false, hidden: false, message: null, beat_id: null, ...fields, purpose, status };
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, builder_id, purpose, subject_id, limit_key, attach, status, hidden, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length, message, beat_id, released_at, created_at, finished_at, moment)
       VALUES($1,$2,$3,$4,$5,$6,'test-limit',$7,$8,$9,'A quiet harbor.',768,768,'fake','fake-image',$2,$10,$11,$12,$13,$14, now() + $15::double precision * interval '1 second', now() + $16 * interval '1 second', now() + $17::double precision * interval '1 second', $18)`,
      [id, row.owner_id, row.session_id, row.builder_id, purpose, row.subject_id, row.attach, status, row.hidden,
        status === 'ready' ? 'a'.repeat(64) : null, status === 'ready' ? 'image/jpeg' : null, status === 'ready' ? 1000 : null, row.message, row.beat_id, releasedAt, clock++, finishedAt, fields.moment ? JSON.stringify({ style: 'Painterly', model: 'flux-3-klein', scene: { title: 'Harbor', description: 'A quiet harbor.', place: 'Harbor' }, lines: [], cast: [], names: [] }) : null]);
    if (fields.shelf || fields.showsBeat) await pool.query('UPDATE images SET shelf_only=$2, shows_beat_id=$3 WHERE id=$1', [id, Boolean(fields.shelf), fields.showsBeat ?? null]);
    return id;
  }
  // Turns a making picture into a ready one that finished that many seconds from now.
  const finish = (id: string, seconds: number) => pool.query(
    "UPDATE images SET status='ready', file_hash=$2, content_type='image/jpeg', byte_length=1000, finished_at=now() + $3::double precision * interval '1 second' WHERE id=$1", [id, 'a'.repeat(64), seconds]);
  // Publishes a beat the way the audit trail sees it: a beats row, its published row and a beat.published event, in that order.
  async function publishBeat() {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'conversation','published','{}')", [id, sessionId]);
    await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,$3,$4)', [id, sessionId, beatCounter++, '{}']);
    await auditEvent('beat.published', { beatId: id });
    return id;
  }
  const auditEvent = (kind: string, data: Record<string, unknown>) =>
    pool.query('INSERT INTO audit_events(id, session_id, actor_id, command_id, kind, data) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), sessionId, ownerId, randomUUID(), kind, data]);
  const lastBeat = async () => {
    const client = await pool.connect();
    try { return await lastBeatInScene(client, sessionId); } finally { client.release(); }
  };
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  async function visible(actor: Actor, id: string, inSession = sessionId, owner = ownerId) {
    const client = await pool.connect();
    try { return await imageVisibleTo(client, actor, inSession, owner, await load(id)); } finally { client.release(); }
  }
  async function scene(id = sceneId) {
    const client = await pool.connect();
    try { return await scenePictureView(client, sessionId, id); } finally { client.release(); }
  }
  async function jobs(ids = npcIds) {
    const client = await pool.connect();
    try { return await portraitJobsView(client, sessionId, ids); } finally { client.release(); }
  }
  const player = (index = 0, session = sessionId): Actor => ({ actor_id: `player-${index}`, role: 'player', session_id: session, character_id: characterIds[index]! });
  const stage: Actor = { actor_id: 'stage-1', role: 'stage', session_id: null, character_id: null };
  const director = (): Actor => ({ actor_id: ownerId, role: 'host', session_id: null, character_id: null });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    clock = 0;
    beatCounter = 1000;
    const host = cookie(await post('/api/auth/host', { token: hostToken }));
    const first = await createSession(host);
    sessionId = first.id; ownerId = first.ownerId; sceneId = first.sceneId;
    otherSessionId = (await createSession(host)).id;
    characterIds = (await pool.query('SELECT id FROM characters WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(row => row.id);
    npcIds = (await pool.query('SELECT id FROM npcs WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(row => row.id);
    expect(characterIds.length).toBeGreaterThan(1);
    expect(npcIds.length).toBeGreaterThan(1);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  describe('scenePictureView', () => {
    it('reports none when the scene has no pictures', async () => {
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'none', imageId: null, hidden: false, message: null, drawing: null } });
    });

    it('reports making with no public picture while the first picture is on its way', async () => {
      await insert({ status: 'making' });
      expect((await scene()).shown).toBeNull();
      expect((await scene()).status).toEqual({ sceneId, state: 'making', imageId: null, hidden: false, message: null, drawing: 'place' });
    });

    it('shows a ready picture to everyone and to the director', async () => {
      const ready = await insert();
      expect(await scene()).toEqual({ shown: { imageId: ready, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: ready, hidden: false, message: null, drawing: null } });
    });

    it('reports failed with its message and no picture when nothing was ever ready', async () => {
      await insert({ status: 'failed', message: 'The picture service would not draw this scene. Press New picture to try again.' });
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'failed', imageId: null, hidden: false, message: 'The picture service would not draw this scene. Press New picture to try again.', drawing: null } });
    });

    it('keeps the older ready picture public while a replacement is making or after it failed', async () => {
      const older = await insert();
      const replacement = await insert({ status: 'making' });
      expect(await scene()).toEqual({ shown: { imageId: older, sceneId, kind: 'place' }, status: { sceneId, state: 'making', imageId: older, hidden: false, message: null, drawing: 'place' } });
      await pool.query("UPDATE images SET status='failed', message='Pictures are busy right now. Try again in a minute.' WHERE id=$1", [replacement]);
      expect(await scene()).toEqual({ shown: { imageId: older, sceneId, kind: 'place' }, status: { sceneId, state: 'failed', imageId: older, hidden: false, message: 'Pictures are busy right now. Try again in a minute.', drawing: null } });
    });

    it('lets the newest ready picture win', async () => {
      await insert();
      const newest = await insert();
      const view = await scene();
      expect(view.shown).toEqual({ imageId: newest, sceneId, kind: 'place' });
      expect(view.status.imageId).toBe(newest);
    });

    it('hides the public picture but still tells the director about it, and takes hidden from the newest row', async () => {
      const ready = await insert({ hidden: true });
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'ready', imageId: ready, hidden: true, message: null, drawing: null } });
      const replacement = await insert({ status: 'making', hidden: true });
      expect((await scene()).status).toMatchObject({ state: 'making', hidden: true, imageId: ready });
      await pool.query("UPDATE images SET hidden=false WHERE id=$1", [replacement]);
      expect((await scene()).status.hidden).toBe(false);
      expect((await scene()).shown).toEqual({ imageId: ready, sceneId, kind: 'place' });
    });

    it('ignores cancelled rows, including a cancelled newest row', async () => {
      const ready = await insert();
      await insert({ status: 'cancelled', hidden: true, message: 'The scene changed before the picture was made.' });
      expect(await scene()).toEqual({ shown: { imageId: ready, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: ready, hidden: false, message: null, drawing: null } });
      await pool.query("UPDATE images SET status='cancelled', file_hash=NULL, content_type=NULL, byte_length=NULL WHERE id=$1", [ready]);
      expect((await scene()).status.state).toBe('none');
    });

    it('only looks at the asked scene of this show and ignores other purposes', async () => {
      await insert({ session_id: otherSessionId, subject_id: sceneId });
      await insert({ subject_id: 'some-other-scene' });
      await insert({ purpose: 'npc', subject_id: sceneId, attach: true });
      expect((await scene()).status.state).toBe('none');
      expect((await scene('some-other-scene')).status.state).toBe('ready');
    });

    it('never counts a held action picture, even a newer ready one', async () => {
      const older = await insert();
      await insert({ beat_id: 'beat-1' });
      expect(await scene()).toEqual({ shown: { imageId: older, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: older, hidden: false, message: null, drawing: null } });
      await insert({ beat_id: 'beat-1', status: 'making' });
      await insert({ beat_id: 'beat-2', status: 'failed', message: 'held failure' });
      expect((await scene()).status).toEqual({ sceneId, state: 'ready', imageId: older, hidden: false, message: null, drawing: null });
    });

    it('reports none while the only pictures are held', async () => {
      await insert({ beat_id: 'beat-1' });
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'none', imageId: null, hidden: false, message: null, drawing: null } });
    });

    it('still reads hidden from a newer held row', async () => {
      const ready = await insert();
      await insert({ beat_id: 'beat-1', status: 'making', hidden: true });
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'ready', imageId: ready, hidden: true, message: null, drawing: null } });
    });

    it('lets a released action picture win by its release time, not its creation time', async () => {
      // The action row is made first and the scene row is created between its creation (0) and its release (100), so only the release time puts the action ahead.
      const action = await insert({ beat_id: 'beat-1', released: 100 });
      const sceneRow = await insert();
      expect((await scene()).shown).toEqual({ imageId: action, sceneId, kind: 'place' });
      expect((await scene()).status.imageId).toBe(action);
      await pool.query("UPDATE images SET released_at=now() - interval '1 hour' WHERE id=$1", [action]);
      expect((await scene()).shown).toEqual({ imageId: sceneRow, sceneId, kind: 'place' });
    });

    it('keeps the older ready picture shown when a released action picture failed', async () => {
      const older = await insert();
      await insert({ beat_id: 'beat-1', status: 'failed', message: 'The picture could not be made.', released: 100 });
      expect(await scene()).toEqual({ shown: { imageId: older, sceneId, kind: 'place' }, status: { sceneId, state: 'failed', imageId: older, hidden: false, message: 'The picture could not be made.', drawing: null } });
    });
  });

  describe('scenePictureView drawing', () => {
    it('says place while a picture of the place is being made', async () => {
      await insert({ status: 'making' });
      expect((await scene()).status).toMatchObject({ state: 'making', drawing: 'place' });
    });

    it('says beat while a picture of a beat is being made, including a hidden one', async () => {
      await insert({ status: 'making', moment: true });
      expect((await scene()).status).toEqual({ sceneId, state: 'making', imageId: null, hidden: false, message: null, drawing: 'beat' });
      await insert({ status: 'making', moment: true, hidden: true });
      expect((await scene()).status).toEqual({ sceneId, state: 'making', imageId: null, hidden: true, message: null, drawing: 'beat' });
    });

    it('follows the newest picture still being made', async () => {
      await insert({ status: 'making', moment: true });
      await insert({ status: 'making' });
      expect((await scene()).status.drawing).toBe('place');
      await insert({ status: 'making', moment: true });
      expect((await scene()).status.drawing).toBe('beat');
    });

    it('reads ready once the newest picture is ready, even while an older one is still being made', async () => {
      await insert({ status: 'making' });
      const newer = await insert({ status: 'ready' });
      const view = (await scene()).status;
      expect(view).toMatchObject({ state: 'ready', drawing: null });
      expect(view.imageId).toBe(newer);
    });

    it('still reads making when a newer picture is being made above an older ready one', async () => {
      await insert({ status: 'ready' });
      await insert({ status: 'making', moment: true });
      expect((await scene()).status).toMatchObject({ state: 'making', drawing: 'beat' });
    });

    it('skips a held action picture when deciding what is being drawn', async () => {
      await insert({ status: 'making', moment: true });
      await insert({ status: 'making', beat_id: 'beat-1' });
      expect((await scene()).status.drawing).toBe('beat');
    });

    it.each(['ready', 'failed'] as const)('is null for a %s beat picture', async (status) => {
      await insert({ status, moment: true, message: status === 'failed' ? PICTURE_MESSAGES.beatFailed : null });
      expect((await scene()).status).toMatchObject({ state: status, drawing: null });
    });

    it('is null when the scene has no picture', async () => {
      expect((await scene()).status.drawing).toBeNull();
    });
  });

  describe('scenePictureView kinds and shelf pictures', () => {
    it('says the shown picture shows a beat when it has a moment and the place otherwise', async () => {
      const place = await insert();
      expect((await scene()).shown).toEqual({ imageId: place, sceneId, kind: 'place' });
      const beat = await insert({ moment: true });
      expect((await scene()).shown).toEqual({ imageId: beat, sceneId, kind: 'beat' });
      const released = await insert({ beat_id: 'beat-1', released: true, moment: true });
      expect((await scene()).shown).toEqual({ imageId: released, sceneId, kind: 'beat' });
    });

    it('never shows a shelf picture, even a newer ready one', async () => {
      const shown = await insert();
      await insert({ shelf: true, moment: true, showsBeat: 'beat-1' });
      expect(await scene()).toEqual({ shown: { imageId: shown, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: shown, hidden: false, message: null, drawing: null } });
    });

    it('leaves the status, the drawing line and the hidden flag alone while a shelf picture is drawn, fails or is hidden', async () => {
      const shown = await insert();
      const expected = { shown: { imageId: shown, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: shown, hidden: false, message: null, drawing: null } };
      await insert({ shelf: true, status: 'making', moment: true });
      expect(await scene()).toEqual(expected);
      await insert({ shelf: true, status: 'failed', message: 'The picture could not be made.' });
      expect(await scene()).toEqual(expected);
      await insert({ shelf: true, hidden: true });
      expect(await scene()).toEqual(expected);
    });

    it('reports none when the scene has only shelf pictures', async () => {
      await insert({ shelf: true });
      expect(await scene()).toEqual({ shown: null, status: { sceneId, state: 'none', imageId: null, hidden: false, message: null, drawing: null } });
    });
  });

  describe('lastBeatInScene', () => {
    it('is null when no beat has been published', async () => {
      expect(await lastBeat()).toBeNull();
    });

    it('is the only published beat when the scene never changed', async () => {
      const first = await publishBeat();
      expect(await lastBeat()).toBe(first);
    });

    it('is the newer of two beats', async () => {
      await publishBeat();
      const second = await publishBeat();
      expect(await lastBeat()).toBe(second);
    });

    it('ignores beats published before the newest scene change', async () => {
      await publishBeat();
      await auditEvent('change_scene', {});
      expect(await lastBeat()).toBeNull();
      const after = await publishBeat();
      expect(await lastBeat()).toBe(after);
    });

    it('goes back to null after a second scene change', async () => {
      await publishBeat();
      await auditEvent('change_scene', {});
      await publishBeat();
      await auditEvent('change_scene', {});
      expect(await lastBeat()).toBeNull();
    });

    it('ignores a beat.published event with no published beat, other shows and other kinds', async () => {
      const real = await publishBeat();
      await auditEvent('beat.published', { beatId: randomUUID() });
      await auditEvent('beat.aborted', { beatId: real });
      const client = await pool.connect();
      try { expect(await lastBeatInScene(client, otherSessionId)).toBeNull(); } finally { client.release(); }
      expect(await lastBeat()).toBe(real);
    });
  });

  describe('scenePictureView ranking by moment', () => {
    it('keeps the action picture when a New picture asked for before the release finishes after it', async () => {
      const newPicture = await insert({ status: 'making' });
      const action = await insert({ beat_id: 'beat-1', released: 100 });
      expect(await scene()).toEqual({ shown: { imageId: action, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: action, hidden: false, message: null, drawing: null } });
      await finish(newPicture, 200);
      expect(await scene()).toEqual({ shown: { imageId: action, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: action, hidden: false, message: null, drawing: null } });
    });

    it('lets a New picture asked for after the release replace the action picture once it finishes', async () => {
      const action = await insert({ beat_id: 'beat-1', released: 0.5 });
      const newPicture = await insert({ status: 'making' });
      expect(await scene()).toEqual({ shown: { imageId: action, sceneId, kind: 'place' }, status: { sceneId, state: 'making', imageId: action, hidden: false, message: null, drawing: 'place' } });
      await finish(newPicture, 200);
      expect(await scene()).toEqual({ shown: { imageId: newPicture, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: newPicture, hidden: false, message: null, drawing: null } });
    });

    it('shows an action picture that was still being made at release over an older ready picture once it is ready', async () => {
      const older = await insert();
      const action = await insert({ beat_id: 'beat-1', status: 'making', released: 100 });
      expect(await scene()).toEqual({ shown: { imageId: older, sceneId, kind: 'place' }, status: { sceneId, state: 'making', imageId: older, hidden: false, message: null, drawing: 'place' } });
      await finish(action, 200);
      expect(await scene()).toEqual({ shown: { imageId: action, sceneId, kind: 'place' }, status: { sceneId, state: 'ready', imageId: action, hidden: false, message: null, drawing: null } });
    });

    it('breaks a tie in the moment by the larger id', async () => {
      const first = await insert();
      const second = await insert();
      await pool.query("UPDATE images SET created_at=now() WHERE id=ANY($1::uuid[])", [[first, second]]);
      expect((await scene()).status.imageId).toBe([first, second].sort().reverse()[0]);
    });
  });

  describe('actionPictureView', () => {
    const action = async (beatId = 'beat-1') => {
      const client = await pool.connect();
      try { return await actionPictureView(client, sessionId, beatId); } finally { client.release(); }
    };

    it('returns null when the round has no held picture', async () => {
      expect(await action()).toBeNull();
    });

    it('reports making, ready and failed with the image only when ready and the message only when failed', async () => {
      const making = await insert({ beat_id: 'beat-1', status: 'making' });
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'making', imageId: null, message: null });
      await pool.query("UPDATE images SET status='ready', file_hash=$2, content_type='image/jpeg', byte_length=1000 WHERE id=$1", [making, 'a'.repeat(64)]);
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'ready', imageId: making, message: null });
      await insert({ beat_id: 'beat-1', status: 'failed', message: PICTURE_MESSAGES.credit });
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'failed', imageId: null, message: PICTURE_MESSAGES.credit });
    });

    it.each([
      ['credit', PICTURE_MESSAGES.credit, PICTURE_MESSAGES.credit],
      ['key', PICTURE_MESSAGES.key, PICTURE_MESSAGES.key],
      ['scene safety', PICTURE_MESSAGES.sceneSafety, 'The picture service would not draw this beat. You can still publish it.'],
      ['beat safety', PICTURE_MESSAGES.beatSafety, 'The picture service would not draw this beat. You can still publish it.'],
      ['beat failed', PICTURE_MESSAGES.beatFailed, null],
      ['scene failed', PICTURE_MESSAGES.sceneFailed, null],
      ['busy', PICTURE_MESSAGES.busy, null],
      ['hourly limit', hourlyLimitMessage(5), null],
      ['no message', null, null],
    ])('turns a failed %s message into the right advice for a round', async (_name, stored, expected) => {
      await insert({ beat_id: 'beat-1', status: 'failed', message: stored });
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'failed', imageId: null, message: expected });
    });

    it('follows the newest held picture of the round', async () => {
      await insert({ beat_id: 'beat-1', status: 'failed', message: 'old' });
      const newest = await insert({ beat_id: 'beat-1' });
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'ready', imageId: newest, message: null });
    });

    it('ignores released, cancelled, other-round and other-show rows', async () => {
      await insert({ beat_id: 'beat-1', released: true });
      await insert({ beat_id: 'beat-1', status: 'cancelled' });
      await insert({ beat_id: 'beat-2' });
      await insert({ beat_id: 'beat-1', session_id: otherSessionId });
      await insert();
      expect(await action()).toBeNull();
      await insert({ beat_id: 'beat-1', status: 'making' });
      expect(await action()).toEqual({ beatId: 'beat-1', state: 'making', imageId: null, message: null });
    });
  });

  describe('portraitJobsView', () => {
    it('returns nothing without characters or rows', async () => {
      expect(await jobs([])).toEqual([]);
      expect(await jobs()).toEqual([]);
    });

    it('returns making and failed jobs only', async () => {
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'making' });
      await insert({ purpose: 'npc', subject_id: npcIds[1]!, attach: true, status: 'failed', message: 'The portrait could not be made. Press Create portrait to try again.' });
      expect(await jobs()).toEqual([
        { npcId: npcIds[0], state: 'making', message: null },
        { npcId: npcIds[1], state: 'failed', message: 'The portrait could not be made. Press Create portrait to try again.' },
      ].sort((a, b) => a.npcId!.localeCompare(b.npcId!)));
    });

    it('drops a character once its newest job is ready, and keeps only the newest job', async () => {
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'failed', message: 'old failure' });
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'ready' });
      expect(await jobs()).toEqual([]);
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'making' });
      expect(await jobs()).toEqual([{ npcId: npcIds[0], state: 'making', message: null }]);
    });

    it('ignores cancelled rows, rows that do not attach, other shows and other characters', async () => {
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'failed', message: 'still the newest real job' });
      await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true, status: 'cancelled' });
      await insert({ purpose: 'npc', subject_id: npcIds[1]!, attach: false, status: 'making' });
      await insert({ purpose: 'npc', subject_id: npcIds[1]!, session_id: otherSessionId, attach: true, status: 'making' });
      expect(await jobs()).toEqual([{ npcId: npcIds[0], state: 'failed', message: 'still the newest real job' }]);
      expect(await jobs([npcIds[1]!])).toEqual([]);
    });
  });

  describe('pinnedPictureView', () => {
    const pin = (id: string | null, session = sessionId) => pool.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [session, id]);
    const pinned = async (session = sessionId) => {
      const client = await pool.connect();
      try { return await pinnedPictureView(client, session); } finally { client.release(); }
    };
    const npcName = async (index: number) => (await pool.query("SELECT data->>'displayName' AS name FROM npcs WHERE id=$1", [npcIds[index]])).rows[0]!.name as string;
    const characterName = async (index: number) => (await pool.query("SELECT data->>'displayName' AS name FROM characters WHERE id=$1", [characterIds[index]])).rows[0]!.name as string;
    async function publishActionRound(round: number) {
      const id = randomUUID();
      await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'action','published','{}')", [id, sessionId]);
      await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,$3,$4)', [id, sessionId, beatCounter, { id, kind: 'action', beatNumber: beatCounter++, actionRoundNumber: round, segments: [] }]);
      return id;
    }

    it('is null when nothing is pinned', async () => {
      await insert();
      expect(await pinned()).toBeNull();
    });

    it('names a pinned place picture, even a hidden or older one', async () => {
      const place = await insert({ hidden: true });
      await insert();
      await pin(place);
      expect(await pinned()).toEqual({ imageId: place, kind: 'place', label: 'The place' });
    });

    it('names a pinned beat picture from an action round by its round', async () => {
      const beatId = await publishActionRound(3);
      const action = await insert({ beat_id: beatId, released: true, moment: true });
      await pin(action);
      expect(await pinned()).toEqual({ imageId: action, kind: 'beat', label: 'Action round 3' });
    });

    it('calls a pinned shelf picture of a beat a beat', async () => {
      const shelf = await insert({ shelf: true, moment: true });
      await pin(shelf);
      expect(await pinned()).toMatchObject({ imageId: shelf, kind: 'beat' });
      expect((await pinned())!.label.length).toBeGreaterThan(0);
    });

    it('names a pinned NPC portrait after its NPC, even when it is no longer the current portrait', async () => {
      const older = await insert({ purpose: 'npc', subject_id: npcIds[1]!, attach: true });
      await pin(older);
      expect(await pinned()).toEqual({ imageId: older, kind: 'portrait', label: `Portrait of ${await npcName(1)}` });
    });

    it('names a pinned library portrait after the character who uses it, and falls back to A portrait', async () => {
      const card = await insert({ purpose: 'card', session_id: null, subject_id: 'editor-key' });
      await pin(card);
      expect(await pinned()).toEqual({ imageId: card, kind: 'portrait', label: 'A portrait' });
      await pool.query("UPDATE characters SET data=jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2", [sessionId, characterIds[1], card]);
      expect(await pinned()).toEqual({ imageId: card, kind: 'portrait', label: `Portrait of ${await characterName(1)}` });
    });

    it.each(['making', 'failed', 'cancelled'] as const)('is null while the pinned picture is %s', async (status) => {
      const picture = await insert({ status });
      await pin(picture);
      expect(await pinned()).toBeNull();
    });

    it('is null for a pinned picture still held for its beat, another show\'s picture or someone else\'s', async () => {
      const held = await insert({ beat_id: 'beat-1', moment: true });
      await pin(held);
      expect(await pinned()).toBeNull();
      const other = await insert({ session_id: otherSessionId });
      await pin(other);
      expect(await pinned()).toBeNull();
      const foreign = await insert({ owner_id: 'someone-else' });
      await pin(foreign);
      expect(await pinned()).toBeNull();
    });

    it('only reads the asked show\'s pin', async () => {
      const place = await insert();
      await pin(place);
      expect(await pinned(otherSessionId)).toBeNull();
    });
  });

  describe('imageVisibleTo', () => {
    const setPortrait = (table: 'npcs' | 'characters', id: string, imageId: string, session = sessionId) =>
      pool.query(`UPDATE ${table} SET data=jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2`, [session, id, imageId]);
    const setDraftPortrait = (id: string, imageId: string) =>
      pool.query("UPDATE characters SET data=data || jsonb_build_object('draft', jsonb_build_object('portraitId', $3::text)) WHERE session_id=$1 AND id=$2", [sessionId, id, imageId]);

    it('lets the director see anything they own and nothing owned by someone else', async () => {
      const hiddenScene = await insert({ hidden: true });
      const unattached = await insert({ purpose: 'npc' });
      const foreign = await insert({ owner_id: 'someone-else' });
      expect(await visible(director(), hiddenScene)).toBe(true);
      expect(await visible(director(), unattached)).toBe(true);
      expect(await visible(director(), foreign)).toBe(false);
      expect(await visible({ ...director(), producer_grant_id: randomUUID() }, hiddenScene)).toBe(true);
    });

    it('shows a scene picture of this show to players and the stage unless it is hidden', async () => {
      const shown = await insert();
      const hiddenScene = await insert({ hidden: true });
      for (const actor of [player(), stage]) {
        expect(await visible(actor, shown)).toBe(true);
        expect(await visible(actor, hiddenScene)).toBe(false);
      }
    });

    it('keeps a held action picture from players and the stage but shows it to the owning director, and shows it to everyone once released', async () => {
      const held = await insert({ beat_id: 'beat-1' });
      const released = await insert({ beat_id: 'beat-1', released: true });
      for (const actor of [player(), stage]) {
        expect(await visible(actor, held)).toBe(false);
        expect(await visible(actor, released)).toBe(true);
      }
      expect(await visible(director(), held)).toBe(true);
      expect(await visible(director(), released)).toBe(true);
      expect(await visible({ ...director(), actor_id: 'someone-else' }, held, sessionId, 'someone-else')).toBe(false);
    });

    it('keeps a scene picture of another show out of reach', async () => {
      const other = await insert({ session_id: otherSessionId });
      expect(await visible(player(), other)).toBe(false);
      expect(await visible(stage, other)).toBe(false);
    });

    it('shows a portrait only while a character or NPC of this show uses it', async () => {
      const npcPortrait = await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true });
      const characterPortrait = await insert({ purpose: 'card', session_id: null, subject_id: 'editor-key' });
      for (const actor of [player(1), stage]) {
        expect(await visible(actor, npcPortrait)).toBe(false);
        expect(await visible(actor, characterPortrait)).toBe(false);
      }
      await setPortrait('npcs', npcIds[0]!, npcPortrait);
      await setPortrait('characters', characterIds[0]!, characterPortrait);
      for (const actor of [player(1), stage]) {
        expect(await visible(actor, npcPortrait)).toBe(true);
        expect(await visible(actor, characterPortrait)).toBe(true);
      }
    });

    it('does not follow a portrait reference into another show', async () => {
      const portrait = await insert({ purpose: 'npc', subject_id: npcIds[0]!, attach: true });
      const otherNpc = (await pool.query('SELECT id FROM npcs WHERE session_id=$1 LIMIT 1', [otherSessionId])).rows[0]!.id as string;
      await setPortrait('npcs', otherNpc, portrait, otherSessionId);
      expect(await visible(stage, portrait)).toBe(false);
      expect(await visible(player(), portrait)).toBe(false);
    });

    it('lets a player see their own draft portrait and their own fresh seat portrait, and nobody else', async () => {
      const draft = await insert({ purpose: 'character', subject_id: characterIds[0]! });
      const fresh = await insert({ purpose: 'character', subject_id: characterIds[0]! });
      const otherDraft = await insert({ purpose: 'character', subject_id: characterIds[1]! });
      await setDraftPortrait(characterIds[0]!, draft);
      expect(await visible(player(0), draft)).toBe(true);
      expect(await visible(player(0), fresh)).toBe(true);
      expect(await visible(player(0), otherDraft)).toBe(false);
      expect(await visible(player(1), draft)).toBe(false);
      expect(await visible(player(1), fresh)).toBe(false);
      expect(await visible(stage, draft)).toBe(false);
      expect(await visible(stage, fresh)).toBe(false);
    });

    it('does not let a player see a fresh seat portrait made in another show', async () => {
      const foreign = await insert({ purpose: 'character', session_id: otherSessionId, subject_id: characterIds[0]! });
      expect(await visible(player(0), foreign)).toBe(false);
    });

    const pin = (id: string, session = sessionId) => pool.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [session, id]);

    it('lets a seat and a stage link fetch the pinned picture, even an older NPC portrait or a hidden picture', async () => {
      const older = await insert({ purpose: 'npc', subject_id: npcIds[1]!, attach: true });
      const hiddenScene = await insert({ hidden: true });
      for (const actor of [player(), stage]) {
        expect(await visible(actor, older)).toBe(false);
        expect(await visible(actor, hiddenScene)).toBe(false);
      }
      await pin(older);
      for (const actor of [player(), stage]) expect(await visible(actor, older)).toBe(true);
      await pin(hiddenScene);
      for (const actor of [player(), stage]) {
        expect(await visible(actor, hiddenScene)).toBe(true);
        expect(await visible(actor, older)).toBe(false);
      }
    });

    it('keeps a shelf picture from seats and the stage until it is pinned, but not from the director', async () => {
      const shelf = await insert({ shelf: true, moment: true, showsBeat: 'beat-1' });
      for (const actor of [player(), stage]) expect(await visible(actor, shelf)).toBe(false);
      expect(await visible(director(), shelf)).toBe(true);
      await pin(shelf);
      for (const actor of [player(), stage]) expect(await visible(actor, shelf)).toBe(true);
    });

    it('keeps another show\'s picture and a held picture private, pinned or not', async () => {
      const other = await insert({ session_id: otherSessionId });
      const held = await insert({ beat_id: 'beat-1', moment: true });
      for (const target of [null, other, held]) {
        if (target) await pin(target);
        for (const actor of [player(), stage]) {
          expect(await visible(actor, other)).toBe(false);
          expect(await visible(actor, held)).toBe(false);
        }
      }
    });

    it('does not let another show\'s pin open a picture', async () => {
      const hiddenScene = await insert({ hidden: true });
      await pin(hiddenScene, otherSessionId);
      expect(await visible(player(), hiddenScene)).toBe(false);
      expect(await visible(stage, hiddenScene)).toBe(false);
    });

    it('never exposes a scene picture through a portrait reference', async () => {
      const hiddenScene = await insert({ hidden: true });
      await setPortrait('npcs', npcIds[0]!, hiddenScene);
      await setPortrait('characters', characterIds[0]!, hiddenScene);
      await setDraftPortrait(characterIds[1]!, hiddenScene);
      for (const actor of [player(0), player(1), stage]) expect(await visible(actor, hiddenScene)).toBe(false);
      expect(await visible(director(), hiddenScene)).toBe(true);
    });
  });
});
