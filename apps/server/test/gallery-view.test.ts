import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createLedgerState } from '@rpg/test-fixtures';
import { createPool, migrate } from '../src/database';
import { galleryPictures, type GalleryView } from '../src/gallery-model';
import { loadGalleryView } from '../src/gallery-view';
import { saveState } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const BASE = Date.UTC(2026, 9, 25, 1, 0, 0);
const at = (seconds: number) => new Date(BASE + seconds * 1000);

interface ImageFields {
  owner?: string; session?: string | null; purpose?: 'scene' | 'npc' | 'character'; subject: string;
  status?: 'making' | 'ready' | 'failed' | 'cancelled'; hidden?: boolean; beatId?: string | null; released?: boolean;
  showsBeatId?: string | null; moment?: Record<string, unknown> | null; contentType?: 'image/jpeg' | 'image/png' | 'image/webp';
  model?: string; prompt?: string; width?: number; height?: number; time: number;
}

suite('loadGalleryView', () => {
  let pool: ReturnType<typeof createPool>;
  const sessionIds: string[] = [];
  const imageIds: string[] = [];
  const ownerId = `gallery-view-owner-${randomUUID()}`;
  const sessionId = `gallery-view-${randomUUID()}`;
  const emptySessionId = `gallery-view-empty-${randomUUID()}`;
  const sceneIds = { first: '', second: randomUUID(), third: randomUUID() };
  const ids: Record<string, string> = {};
  let view: GalleryView;
  let hashCounter = 0;

  async function image(fields: ImageFields) {
    const id = randomUUID();
    imageIds.push(id);
    const status = fields.status ?? 'ready';
    const hasFile = status === 'ready' || status === 'cancelled';
    const contentType = fields.contentType ?? 'image/jpeg';
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, hidden, prompt, width, height, provider, model,
         requested_by, file_hash, content_type, byte_length, beat_id, released_at, shows_beat_id, moment, created_at)
       VALUES($1,$2,$3,$4,$5,'gallery-view-test',$6,$7,$8,$9,$10,'fake',$11,$2,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, fields.owner ?? ownerId, fields.session === undefined ? sessionId : fields.session, fields.purpose ?? 'scene', fields.subject,
        status, fields.hidden ?? false, fields.prompt ?? `Prompt for ${id}`, fields.width ?? 768, fields.height ?? 512, fields.model ?? 'flux-3-klein',
        hasFile ? (++hashCounter).toString(16).padStart(64, '0') : null, hasFile ? contentType : null, hasFile ? 1000 : null,
        fields.beatId ?? null, fields.released ? at(fields.time + 1) : null, fields.showsBeatId ?? null,
        fields.moment ? JSON.stringify(fields.moment) : null, at(fields.time)]);
    return id;
  }

  async function event(session: string, kind: string, data: Record<string, unknown>, time: number) {
    await pool.query('INSERT INTO audit_events(id, session_id, actor_id, command_id, kind, data, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), session, ownerId, randomUUID(), kind, data, at(time)]);
  }

  async function publish(beatNumber: number, actionRoundNumber: number, segments: { kind: string; text: string }[]) {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'action','published','{}')", [id, sessionId]);
    await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,$3,$4)', [id, sessionId, beatNumber, {
      id, kind: 'action', beatNumber, actionRoundNumber, stateRevision: 1, publishedAt: at(0).toISOString(), rolls: [], outcomes: [], textOnly: true,
      segments: segments.map((segment, index) => ({ id: `${id}-${index}`, kind: segment.kind, text: segment.text, speaker: null,
        recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false })),
    }]);
    return id;
  }

  async function createSession(id: string) {
    sessionIds.push(id);
    const state = createLedgerState(id, randomUUID);
    await pool.query('INSERT INTO sessions(id, owner_id, title, scene, status) VALUES($1,$2,$3,$4,$5)', [id, ownerId, state.session.title, state.session.scene, 'ended']);
    return state;
  }

  async function save(state: ReturnType<typeof createLedgerState>) {
    const client = await pool.connect();
    try { await saveState(client, state); } finally { client.release(); }
  }

  async function load(id: string) {
    const client = await pool.connect();
    try { return await loadGalleryView(client, id); } finally { client.release(); }
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);

    const state = await createSession(sessionId);
    state.session.title = 'The <Canal> Job';
    state.session.status = 'ended';
    state.directorNotes = 'DIRECTOR-NOTE-never-public';
    sceneIds.first = state.session.scene.id;
    const openingScene = structuredClone(state.session.scene);
    const [rook, lark, quill, pip] = state.characters;
    quill!.approved = false;
    const [mara, dax, biscuit] = state.npcs;
    mara!.hiddenIdentity = 'HIDDEN-IDENTITY-never-public';
    mara!.secrets = ['NPC-SECRET-never-public'];
    const oldTom = { ...structuredClone(biscuit!), id: randomUUID(), displayName: 'Old Tom', secrets: [] };
    delete oldTom.portraitId;
    state.npcs.push(oldTom);
    const goneNpcId = randomUUID();

    ids.rookPortrait = await image({ session: sessionId, purpose: 'character', subject: rook!.id, contentType: 'image/png', time: 1, prompt: 'Rook in a waistcoat.' });
    ids.rookDiscarded = await image({ purpose: 'character', subject: rook!.id, time: 2 });
    ids.quillDraft = await image({ purpose: 'character', subject: quill!.id, time: 3 });
    rook!.portraitId = ids.rookPortrait;
    quill!.portraitId = ids.quillDraft;

    ids.maraOlder = await image({ purpose: 'npc', subject: mara!.id, time: 4 });
    ids.tomRemoved = await image({ purpose: 'npc', subject: oldTom.id, time: 5 });
    ids.maraOlderCancelled = await image({ purpose: 'npc', subject: mara!.id, status: 'cancelled', time: 6 });
    ids.maraFailed = await image({ purpose: 'npc', subject: mara!.id, status: 'failed', time: 7 });
    ids.maraCurrent = await image({ purpose: 'npc', subject: mara!.id, time: 8, contentType: 'image/webp' });
    ids.goneNpc = await image({ purpose: 'npc', subject: goneNpcId, time: 9 });
    ids.daxLibrary = await image({ session: null, purpose: 'npc', subject: dax!.id, time: 10 });
    ids.biscuitForeign = await image({ owner: `gallery-view-other-${randomUUID()}`, session: null, purpose: 'npc', subject: biscuit!.id, time: 11 });
    mara!.portraitId = ids.maraCurrent;
    dax!.portraitId = ids.daxLibrary;
    biscuit!.portraitId = ids.biscuitForeign;

    const roundOne = await publish(2, 1, [{ kind: 'npc_dialogue', text: 'Halt there.' }, { kind: 'narration', text: 'The gate groans open. Rain follows.' }]);
    const roundTwo = await publish(4, 2, [{ kind: 'narration', text: 'Lanterns swing over the canal! Boats scatter.' }]);
    const beatThree = await publish(3, 1, [{ kind: 'npc_dialogue', text: 'You came back? Good.' }]);

    ids.hiddenPlace = await image({ subject: sceneIds.first, hidden: true, time: 20, prompt: 'A rainy club, "quiet" & dim.' });
    ids.replacedPublished = await image({ prompt: 'DRAFT-NARRATION-never-aired: The vault door swings open.', subject: sceneIds.first, status: 'cancelled', beatId: roundOne, released: true, time: 21 });
    ids.releasedRound = await image({ subject: sceneIds.first, beatId: roundOne, released: true, time: 22, model: 'mystery-model' });
    ids.replacedUnpublished = await image({ prompt: 'DRAFT-NARRATION-never-aired: The vault door swings open.', subject: sceneIds.first, status: 'cancelled', beatId: 'beat-that-never-aired', time: 23 });
    ids.neverPublished = await image({ prompt: 'DRAFT-NARRATION-never-aired: The vault door swings open.', subject: sceneIds.first, beatId: 'beat-that-never-aired-2', time: 24 });
    ids.neverReleased = await image({ subject: sceneIds.third, beatId: roundTwo, time: 25 });
    ids.lastBeat = await image({ subject: sceneIds.third, showsBeatId: beatThree, time: 26 });
    ids.olderMoment = await image({ subject: sceneIds.third, time: 27, moment: {
      style: 'Painterly', model: 'krea-2-turbo', scene: { title: 'Canal', description: 'A canal.', place: 'Canal' },
      lines: [{ kind: 'npc_dialogue', speaker: 'Mara', text: 'Over here.' }, { kind: 'narration', speaker: null, text: 'The boat tips. Everyone grabs the rail.' }],
      cast: [], names: [] } });
    ids.sceneFailed = await image({ subject: sceneIds.third, status: 'failed', time: 28 });
    ids.strayScene = await image({ subject: randomUUID(), time: 29 });
    ids.sceneMaking = await image({ subject: sceneIds.third, status: 'making', time: 30 });
    ids.npcMaking = await image({ purpose: 'npc', subject: mara!.id, status: 'making', time: 31 });
    ids.characterMaking = await image({ purpose: 'character', subject: lark!.id, status: 'making', time: 32 });
    void pip;

    const secondScene = { id: sceneIds.second, title: 'The Canal Gate', description: 'PRIVATE-SCENE-DESCRIPTION', locationId: openingScene.locationId };
    const thirdScene = { id: sceneIds.third, title: 'Under the Bridge', description: 'Water drips.', locationId: openingScene.locationId };
    const privateLocations = [{ id: openingScene.locationId, title: 'Club', description: 'PRIVATE-LOCATION-NOTE' }];
    await event(sessionId, 'change_scene', { reason: 'PRIVATE-REASON-one', before: { scene: openingScene, locations: privateLocations, npcs: state.npcs }, after: { scene: secondScene, locations: privateLocations, npcs: state.npcs } }, 40);
    await event(sessionId, 'change_scene', { reason: 'PRIVATE-REASON-two', before: { scene: secondScene, locations: privateLocations, npcs: state.npcs }, after: { scene: thirdScene, locations: privateLocations, npcs: state.npcs } }, 41);
    const notAScene = randomUUID();
    ids.notASceneRow = await image({ subject: notAScene, time: 33 });
    await event(sessionId, 'save_npc', { before: { scene: { id: notAScene, title: 'Not a scene change' } }, after: { scene: { id: notAScene, title: 'Not a scene change' } } }, 42);
    state.session.scene = thirdScene;
    await event(sessionId, 'set_status', { status: 'paused' }, 100);
    await event(sessionId, 'set_status', { status: 'ended' }, 200);
    await save(state);

    view = await load(sessionId);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM images WHERE id = ANY($1::uuid[])', [imageIds]);
    await pool.query('DELETE FROM audit_events WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM published_beats WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM beats WHERE session_id = ANY($1::text[])', [sessionIds]);
    for (const table of ['characters', 'npcs', 'tracks', 'facts']) await pool.query(`DELETE FROM ${table} WHERE session_id = ANY($1::text[])`, [sessionIds]);
    await pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
    await pool.end();
  });

  it('carries the show title, end date and pending count', () => {
    expect(view.sessionId).toBe(sessionId);
    expect(view.title).toBe('The <Canal> Job');
    expect(view.endedAt).toBe(at(200).toISOString());
    expect(view.pending).toBe(2);
  });

  it('numbers scenes by their place in the show and leaves out scenes without pictures', () => {
    expect(view.scenes.map(scene => [scene.number, scene.title])).toEqual([[1, 'The Velvet Ledger'], [3, 'Under the Bridge']]);
    expect(view.scenes[0]!.pictures.map(picture => picture.id)).toEqual([ids.hiddenPlace, ids.replacedPublished, ids.releasedRound, ids.replacedUnpublished, ids.neverPublished]);
    expect(view.scenes[1]!.pictures.map(picture => picture.id)).toEqual([ids.neverReleased, ids.lastBeat, ids.olderMoment]);
  });

  it('keeps every picture\'s prompt, drafts and never-published rounds included', () => {
    const byId = new Map(galleryPictures(view).map(picture => [picture.id, picture]));
    for (const key of ['replacedPublished', 'replacedUnpublished', 'neverPublished']) {
      expect(byId.get(ids[key]!)!.prompt).toBe('DRAFT-NARRATION-never-aired: The vault door swings open.');
    }
    for (const key of ['releasedRound', 'neverReleased']) expect(byId.get(ids[key]!)!.prompt).toBe(`Prompt for ${ids[key]}`);
  });

  it('captions every kind of scene row', () => {
    const captions = view.scenes.flatMap(scene => scene.pictures.map(({ label, line, tag }) => ({ label, line, tag })));
    expect(captions).toEqual([
      { label: 'The place', line: null, tag: 'Hidden' },
      { label: 'Earlier draft of action round 1', line: 'The gate groans open.', tag: 'Not shown on stream' },
      { label: 'Action round 1', line: 'The gate groans open.', tag: null },
      { label: 'Earlier draft of a round', line: null, tag: 'Not shown on stream' },
      { label: 'A round that was never published', line: null, tag: 'Not shown on stream' },
      { label: 'Action round 2', line: 'Lanterns swing over the canal!', tag: 'Not shown on stream' },
      { label: 'Beat 3', line: 'You came back?', tag: null },
      { label: 'A beat', line: 'The boat tips.', tag: null },
    ]);
  });

  it('gives each picture its file, size, model label and prompt', () => {
    const place = view.scenes[0]!.pictures[0]!;
    expect(place).toMatchObject({ file: `${ids.hiddenPlace}.jpg`, contentType: 'image/jpeg', width: 768, height: 512, model: 'FLUX 3 Klein', prompt: 'A rainy club, "quiet" & dim.' });
    expect(place.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.scenes[0]!.pictures[2]!.model).toBe('mystery-model');
  });

  it('builds the cast from approved players in seat order, then non-player characters with a usable portrait', () => {
    expect(view.cast.map(member => [member.kind, member.name, member.initials, member.portrait?.id ?? null])).toEqual([
      ['player', 'Rook', 'R', ids.rookPortrait],
      ['player', 'Lark', 'L', null],
      ['player', 'Pip', 'P', null],
      ['npc', 'Mara Vale', 'MV', ids.maraCurrent],
      ['npc', 'Inspector Dax', 'ID', ids.daxLibrary],
    ]);
    expect(view.cast[0]!.portrait).toMatchObject({ label: 'Rook', line: null, tag: null, file: `${ids.rookPortrait}.png`, prompt: 'Rook in a waistcoat.' });
    expect(view.cast[3]!.portrait).toMatchObject({ label: 'Mara Vale', file: `${ids.maraCurrent}.webp` });
  });

  it('groups older and removed non-player portraits by name and leaves out the current one', () => {
    expect(view.morePortraits.map(group => [group.name, group.pictures.map(picture => picture.id)])).toEqual([
      ['Mara Vale', [ids.maraOlder, ids.maraOlderCancelled]],
      ['Old Tom', [ids.tomRemoved]],
    ]);
    expect(view.morePortraits[0]!.pictures[0]).toMatchObject({ label: 'Mara Vale', line: null, tag: null });
  });

  it('keeps two non-player characters with the same name in separate More portraits groups', async () => {
    const id = `gallery-view-twins-${randomUUID()}`;
    const state = await createSession(id);
    const [first, second] = state.npcs;
    second!.displayName = first!.displayName;
    await image({ session: id, purpose: 'npc', subject: first!.id, time: 1 });
    await image({ session: id, purpose: 'npc', subject: second!.id, time: 2 });
    await save(state);
    const twins = await load(id);
    expect(twins.morePortraits.map(group => [group.name, group.pictures.length])).toEqual([[first!.displayName, 1], [first!.displayName, 1]]);
  });

  it('shows a Library portrait on a player character card', async () => {
    const id = `gallery-view-library-${randomUUID()}`;
    const state = await createSession(id);
    const player = state.characters.find(character => character.approved)!;
    const library = await image({ session: null, purpose: 'npc', subject: player.id, time: 1 });
    player.portraitId = library;
    await save(state);
    const loaded = await load(id);
    expect(loaded.cast.find(member => member.kind === 'player' && member.name === player.displayName)!.portrait?.id).toBe(library);
  });

  it('shows a session portrait on a player character card', async () => {
    const id = `gallery-view-session-portrait-${randomUUID()}`;
    const state = await createSession(id);
    const player = state.characters.find(character => character.approved)!;
    const own = await image({ session: id, purpose: 'character', subject: player.id, time: 1, contentType: 'image/webp' });
    player.portraitId = own;
    await save(state);
    const loaded = await load(id);
    const card = loaded.cast.find(member => member.kind === 'player' && member.name === player.displayName)!;
    expect(card.portrait).toMatchObject({ id: own, file: `${own}.webp` });
  });

  it('takes the first untagged scene picture as the cover', () => {
    expect(view.cover?.id).toBe(ids.releasedRound);
  });

  it('keeps unapproved cards, discarded tries, failed rows and private text out of the view', () => {
    const text = JSON.stringify(view);
    for (const id of [ids.rookDiscarded, ids.quillDraft, ids.biscuitForeign, ids.maraFailed, ids.goneNpc, ids.sceneFailed, ids.strayScene, ids.notASceneRow, ids.sceneMaking, ids.npcMaking, ids.characterMaking]) {
      expect(text).not.toContain(id);
    }
    for (const secret of ['Quill', 'Biscuit', 'DIRECTOR-NOTE', 'NPC-SECRET', 'HIDDEN-IDENTITY', 'PRIVATE-REASON', 'PRIVATE-LOCATION', 'PRIVATE-SCENE-DESCRIPTION', 'Not a scene change', 'Owes the missing owner a favor.']) {
      expect(text).not.toContain(secret);
    }
  });

  it('uses the current scene when the show never changed scene, and has no end date before a status change', async () => {
    const state = await createSession(emptySessionId);
    await save(state);
    const sceneId = state.session.scene.id;
    const placeId = await image({ session: emptySessionId, subject: sceneId, time: 50 });
    const empty = await load(emptySessionId);
    expect(empty.endedAt).toBeNull();
    expect(empty.pending).toBe(0);
    expect(empty.scenes).toEqual([expect.objectContaining({ number: 1, title: 'The Velvet Ledger', pictures: [expect.objectContaining({ id: placeId, label: 'The place', tag: null })] })]);
    expect(empty.cast.map(member => member.name)).toEqual(['Rook', 'Lark', 'Quill', 'Pip']);
    expect(empty.morePortraits).toEqual([]);
    expect(empty.cover?.id).toBe(placeId);
  });

  it('refuses a session that does not exist', async () => {
    await expect(load(`gallery-view-missing-${randomUUID()}`)).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Session was not found.' });
  });
});
