import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BeatSchema, DEFAULT_PICTURE_STYLE, PICTURE_MODELS } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { project, type Actor } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'snapshot-pictures-test-host-credential';

suite('snapshot picture fields', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let sessionId: string, ownerId: string, sceneId: string;
  let characterIds: string[], npcIds: string[];
  let sceneImage: string, approvedPortrait: string, draftPortrait: string, npcPortrait: string;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const director = (): Actor => ({ actor_id: ownerId, role: 'host', session_id: null, character_id: null });
  const stage = (): Actor => ({ actor_id: 'stage-1', role: 'stage', session_id: sessionId, character_id: null });
  const player = (index: number): Actor => ({ actor_id: `player-${index}`, role: 'player', session_id: sessionId, character_id: characterIds[index]! });
  const snapshot = (actor: Actor, picturesEnabled: boolean) => transaction(pool, client => project(client, sessionId, actor, undefined, { picturesEnabled }));
  const directed = async (options: { picturesEnabled?: boolean; defaultPictureModel?: string }) => {
    const view = await transaction(pool, client => project(client, sessionId, director(), undefined, options));
    if (view.role !== 'director') throw new Error('expected the director view');
    return view;
  };
  const auditEvent = (kind: string, data: Record<string, unknown>) =>
    pool.query('INSERT INTO audit_events(id, session_id, actor_id, command_id, kind, data) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), sessionId, ownerId, randomUUID(), kind, data]);
  async function publishBeat() {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'conversation','published','{}')", [id, sessionId]);
    const number = Number((await pool.query('SELECT COALESCE(MAX(beat_number),0)+1 AS n FROM published_beats WHERE session_id=$1', [sessionId])).rows[0].n);
    await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,$3,$4)', [id, sessionId, number, { id, kind: 'conversation', beatNumber: number, actionRoundNumber: 0, stateRevision: 0, publishedAt: new Date().toISOString(), segments: [], rolls: [], outcomes: [], textOnly: true }]);
    await auditEvent('beat.published', { beatId: id });
    return id;
  }
  async function insert(fields: { purpose: string; subjectId: string; status?: string; hidden?: boolean; attach?: boolean; message?: string | null; beatId?: string; released?: boolean }) {
    const id = randomUUID();
    const status = fields.status ?? 'ready';
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, hidden, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length, message, beat_id, released_at)
       VALUES($1,$2,$3,$4,$5,'test-limit',$6,$7,$8,'A quiet harbor.',768,768,'fake','fake-image',$2,$9,$10,$11,$12,$13,CASE WHEN $14::boolean THEN clock_timestamp() END)`,
      [id, ownerId, sessionId, fields.purpose, fields.subjectId, fields.attach ?? false, status, fields.hidden ?? false,
        status === 'ready' ? 'a'.repeat(64) : null, status === 'ready' ? 'image/jpeg' : null, status === 'ready' ? 1000 : null, fields.message ?? null, fields.beatId ?? null, fields.released ?? false]);
    return id;
  }
  const setPortrait = (table: 'characters' | 'npcs', id: string, imageId: string) =>
    pool.query(`UPDATE ${table} SET data = jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2`, [sessionId, id, imageId]);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    const host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: randomUUID() } })).json();
    sessionId = created.sessionId;
    const row = (await pool.query('SELECT owner_id, scene FROM sessions WHERE id=$1', [sessionId])).rows[0];
    ownerId = row.owner_id; sceneId = row.scene.id;
    characterIds = (await pool.query('SELECT id FROM characters WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(r => r.id);
    npcIds = (await pool.query('SELECT id FROM npcs WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(r => r.id);
    expect(characterIds.length).toBeGreaterThan(1);
    expect(npcIds.length).toBeGreaterThan(1);
    // Character 0 is approved with a public portrait; character 1 waits for approval with a portrait only in its draft.
    approvedPortrait = await insert({ purpose: 'character', subjectId: characterIds[0]! });
    draftPortrait = await insert({ purpose: 'character', subjectId: characterIds[1]! });
    npcPortrait = await insert({ purpose: 'npc', subjectId: npcIds[0]! });
    sceneImage = await insert({ purpose: 'scene', subjectId: sceneId });
    await pool.query("UPDATE characters SET data = jsonb_set(data, '{approved}', 'true') WHERE session_id=$1 AND id=$2", [sessionId, characterIds[0]]);
    await setPortrait('characters', characterIds[0]!, approvedPortrait);
    await setPortrait('npcs', npcIds[0]!, npcPortrait);
    const waiting = (await pool.query('SELECT data FROM characters WHERE session_id=$1 AND id=$2', [sessionId, characterIds[1]])).rows[0].data;
    const draft = { schemaVersion: 1, displayName: waiting.displayName, traits: waiting.traits, portraitId: draftPortrait };
    await pool.query("UPDATE characters SET data = jsonb_set(jsonb_set(data, '{approved}', 'false'), '{draft}', $3::jsonb) WHERE session_id=$1 AND id=$2", [sessionId, characterIds[1], JSON.stringify(draft)]);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('gives every role the picture flag, the shown scene picture and the approved portraits', async () => {
    for (const actor of [stage(), player(0), director()]) {
      const view = await snapshot(actor, true);
      expect(view.picturesEnabled).toBe(true);
      expect(view.scenePicture).toEqual({ imageId: sceneImage, sceneId });
      expect(view.characters.find(c => c.id === characterIds[0])?.portraitId).toBe(approvedPortrait);
      expect(view.npcs.find(n => n.id === npcIds[0])?.portraitId).toBe(npcPortrait);
    }
  });

  it('keeps the status and portrait jobs for the director only', async () => {
    await insert({ purpose: 'npc', subjectId: npcIds[1]!, status: 'failed', attach: true, message: 'The portrait could not be made.' });
    const view = await snapshot(director(), true);
    if (view.role !== 'director') throw new Error('expected the director view');
    expect(view.scenePictureStatus).toEqual({ sceneId, state: 'ready', imageId: sceneImage, hidden: false, message: null, drawing: null });
    expect(view.portraitJobs).toEqual([{ npcId: npcIds[1], state: 'failed', message: 'The portrait could not be made.' }]);
    for (const actor of [stage(), player(0)]) {
      const other = await snapshot(actor, true);
      expect(other).not.toHaveProperty('scenePictureStatus');
      expect(other).not.toHaveProperty('portraitJobs');
    }
  });

  it('reports nulls, an empty job list and a false flag when pictures are off', async () => {
    for (const actor of [stage(), player(0), director()]) {
      const view = await snapshot(actor, false);
      expect(view.picturesEnabled).toBe(false);
      expect(view.scenePicture).toBeNull();
      if (view.role === 'director') {
        expect(view.scenePictureStatus).toBeNull();
        expect(view.portraitJobs).toEqual([]);
      }
    }
    const defaulted = await transaction(pool, client => project(client, sessionId, stage()));
    expect(defaulted.picturesEnabled).toBe(false);
    expect(defaulted.scenePicture).toBeNull();
  });

  it('hides a hidden scene picture from the stage and players but not from the director', async () => {
    await pool.query('UPDATE images SET hidden=true WHERE id=$1', [sceneImage]);
    for (const actor of [stage(), player(0)]) expect((await snapshot(actor, true)).scenePicture).toBeNull();
    const view = await snapshot(director(), true);
    expect(view.scenePicture).toBeNull();
    if (view.role !== 'director') throw new Error('expected the director view');
    expect(view.scenePictureStatus).toEqual({ sceneId, state: 'ready', imageId: sceneImage, hidden: true, message: null, drawing: null });
  });

  it('shows a picture of an earlier scene to nobody', async () => {
    await pool.query("UPDATE images SET subject_id='another-scene' WHERE id=$1", [sceneImage]);
    expect((await snapshot(stage(), true)).scenePicture).toBeNull();
    const view = await snapshot(director(), true);
    if (view.role !== 'director') throw new Error('expected the director view');
    expect(view.scenePictureStatus).toMatchObject({ state: 'none', imageId: null });
  });

  it('keeps a draft portrait private to its player and the director', async () => {
    const stageView = await snapshot(stage(), true);
    expect(stageView.characters.map(c => c.id)).not.toContain(characterIds[1]);
    expect(JSON.stringify(stageView)).not.toContain(draftPortrait);

    const own = await snapshot(player(1), true);
    if (own.role !== 'player') throw new Error('expected the player view');
    expect(own.ownCharacter?.draft?.portraitId).toBe(draftPortrait);
    expect(own.characters.find(c => c.id === characterIds[1])?.portraitId).toBeUndefined();

    const other = await snapshot(player(0), true);
    if (other.role !== 'player') throw new Error('expected the player view');
    expect(JSON.stringify(other)).not.toContain(draftPortrait);

    const directed = await snapshot(director(), true);
    if (directed.role !== 'director') throw new Error('expected the director view');
    expect(directed.characterDetails.find(c => c.id === characterIds[1])?.draft?.portraitId).toBe(draftPortrait);
    expect(directed.characters.find(c => c.id === characterIds[1])?.portraitId).toBeUndefined();
  });

  async function insertBeat(kind: 'action' | 'conversation', phase: string) {
    const id = randomUUID();
    const data = BeatSchema.parse({ id, sessionId, kind, phase, revision: 1, inputEpoch: 0, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], stakesApproved: false, classification: null, inputSnapshotHash: null, resolution: null,
      draft: { segments: [{ kind: 'narration', text: 'The door bursts open.', delivery: 'neutral', recipientCharacterIds: [] }], continuity: [], directorSummary: '' }, draftRevision: 0, approvedContinuity: [], generation: 0, lastError: null, steering: '' });
    await pool.query('INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,$3,$4,$5)', [id, sessionId, kind, phase, data]);
    return id;
  }
  const actionOf = async (actor: Actor, picturesEnabled = true) => {
    const view = await snapshot(actor, picturesEnabled);
    if (view.role !== 'director') throw new Error('expected the director view');
    return view.actionPicture;
  };

  it('reports the held action picture to the director as making, ready or failed', async () => {
    const beatId = await insertBeat('action', 'draft_review');
    expect(await actionOf(director())).toBeNull();
    const held = await insert({ purpose: 'scene', subjectId: sceneId, beatId, status: 'making' });
    expect(await actionOf(director())).toEqual({ beatId, state: 'making', imageId: null, message: null });
    await pool.query("UPDATE images SET status='ready', file_hash=$2, content_type='image/jpeg', byte_length=1000 WHERE id=$1", [held, 'a'.repeat(64)]);
    expect(await actionOf(director())).toEqual({ beatId, state: 'ready', imageId: held, message: null });
    await insert({ purpose: 'scene', subjectId: sceneId, beatId, status: 'failed', message: 'The picture could not be made.' });
    expect(await actionOf(director())).toEqual({ beatId, state: 'failed', imageId: null, message: null });
  });

  it('has no action picture with pictures off, for a conversation beat or after the draft review', async () => {
    const beatId = await insertBeat('action', 'draft_review');
    await insert({ purpose: 'scene', subjectId: sceneId, beatId });
    expect(await actionOf(director())).not.toBeNull();
    expect(await actionOf(director(), false)).toBeNull();
    await pool.query("UPDATE beats SET phase='locked', data=jsonb_set(data,'{phase}',to_jsonb('locked'::text)) WHERE id=$1", [beatId]);
    expect(await actionOf(director())).toBeNull();
    await pool.query("UPDATE beats SET phase='aborted', data=jsonb_set(data,'{phase}',to_jsonb('aborted'::text)) WHERE id=$1", [beatId]);
    const talk = await insertBeat('conversation', 'draft_review');
    await insert({ purpose: 'scene', subjectId: sceneId, beatId: talk });
    expect(await actionOf(director())).toBeNull();
  });

  it('keeps a held action picture and the actionPicture field away from the stage and players until it is released', async () => {
    const beatId = await insertBeat('action', 'draft_review');
    const held = await insert({ purpose: 'scene', subjectId: sceneId, beatId });
    for (const actor of [stage(), player(0)]) {
      const view = await snapshot(actor, true);
      expect(view).not.toHaveProperty('actionPicture');
      expect(view.scenePicture).toEqual({ imageId: sceneImage, sceneId });
    }
    await pool.query('UPDATE images SET released_at=clock_timestamp() WHERE id=$1', [held]);
    for (const actor of [stage(), player(0)]) expect((await snapshot(actor, true)).scenePicture).toEqual({ imageId: held, sceneId });
  });

  it('gives the director the effective picture settings only with pictures on and a default model', async () => {
    const model = PICTURE_MODELS[0]!.id;
    expect((await directed({ picturesEnabled: false, defaultPictureModel: model })).pictureSettings).toBeNull();
    expect((await directed({ picturesEnabled: true })).pictureSettings).toBeNull();
    expect((await directed({ picturesEnabled: true, defaultPictureModel: 'fake-image' })).pictureSettings).toEqual({ style: DEFAULT_PICTURE_STYLE, model: 'fake-image' });
  });

  it('returns saved picture settings and falls back to the default for an unknown saved model', async () => {
    const [first, second] = [PICTURE_MODELS[0]!.id, PICTURE_MODELS[1]!.id];
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Chalk drawing', model: second })]);
    expect((await directed({ picturesEnabled: true, defaultPictureModel: first })).pictureSettings).toEqual({ style: 'Chalk drawing', model: second });
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Chalk drawing', model: 'not-a-listed-model' })]);
    expect((await directed({ picturesEnabled: true, defaultPictureModel: first })).pictureSettings).toEqual({ style: 'Chalk drawing', model: first });
  });

  it('names the newest beat published after the latest scene change, and only with pictures on', async () => {
    const model = PICTURE_MODELS[0]!.id;
    expect((await directed({ picturesEnabled: true, defaultPictureModel: model })).lastSceneBeatId).toBeNull();
    const first = await publishBeat();
    expect((await directed({ picturesEnabled: false, defaultPictureModel: model })).lastSceneBeatId).toBeNull();
    expect((await directed({ picturesEnabled: true, defaultPictureModel: model })).lastSceneBeatId).toBe(first);
    const second = await publishBeat();
    expect((await directed({ picturesEnabled: true })).lastSceneBeatId).toBe(second);
    await auditEvent('change_scene', {});
    expect((await directed({ picturesEnabled: true })).lastSceneBeatId).toBeNull();
    const third = await publishBeat();
    expect((await directed({ picturesEnabled: true })).lastSceneBeatId).toBe(third);
  });

  it('keeps the new picture fields off the stage and player snapshots', async () => {
    await publishBeat();
    for (const actor of [stage(), player(0)]) {
      const view = await transaction(pool, client => project(client, sessionId, actor, undefined, { picturesEnabled: true, defaultPictureModel: 'fake-image' }));
      expect(view).not.toHaveProperty('pictureSettings');
      expect(view).not.toHaveProperty('lastSceneBeatId');
    }
  });
});
