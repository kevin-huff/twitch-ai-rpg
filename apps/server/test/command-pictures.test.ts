import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CommandSchema, type AiDraft, type Beat, type CommandResponse, type DirectorSnapshot, type ProviderContext, type SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { executeCommand, type CommandDependencies, type CommandPictures } from '../src/commands';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';
import { FakeImageProvider } from '../src/fake-images';
import { draftNarration } from '../src/picture-prompts';
import { project, type Actor } from '../src/repository';
import { imageVisibleTo, type ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'command-pictures-test-host-credential';
const PORTRAIT_SENTENCE = 'That portrait is not available for this card. Create a new one.';

type PictureCall = { kind: 'scene'; sceneId: string } | { kind: 'npc'; npcId: string } | { kind: 'action'; beatId: string; narration: string }
  | { kind: 'release'; beatId: string; publishedInside: number; publishedOutside: number };

// Each render tells a slightly different story, so the narration changes every time.
class ChangingProvider extends FakeAiProvider {
  private count = 0;
  async render(context: ProviderContext): Promise<AiDraft> {
    const draft = await super.render(context);
    this.count++;
    return { ...draft, segments: draft.segments.map(segment => segment.kind === 'narration' ? { ...segment, text: `${segment.text} Take ${this.count}.` } : segment) };
  }
}
class FailingProvider extends FakeAiProvider {
  async render(): Promise<AiDraft> { throw new Error('The model is down.'); }
}
class GatedProvider extends FakeAiProvider {
  open!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.open = resolve; });
  async render(context: ProviderContext): Promise<AiDraft> {
    await this.gate;
    return super.render(context);
  }
}

// The stub reserves a 'making' row on the command's own client, so it commits or rolls back with the command.
class StubPictures implements CommandPictures {
  calls: PictureCall[] = [];
  runs: string[][] = [];
  seenAtRun: Promise<string[]>[] = [];
  constructor(private readonly pool: ReturnType<typeof createPool>) {}
  private async insert(client: PoolClient, state: SessionState, actor: Actor, purpose: 'scene' | 'npc', subjectId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,'making','A quiet harbor.',768,768,'fake','fake-image',$2)`,
      [id, actor.actor_id, state.session.id, purpose, subjectId, `${purpose}:${state.session.id}`, purpose === 'npc']);
    return id;
  }
  async reserveScene(client: PoolClient, state: SessionState, actor: Actor) {
    this.calls.push({ kind: 'scene', sceneId: state.session.scene.id });
    return this.insert(client, state, actor, 'scene', state.session.scene.id);
  }
  async reserveNpcPortrait(client: PoolClient, state: SessionState, npcId: string, actor: Actor) {
    this.calls.push({ kind: 'npc', npcId });
    return this.insert(client, state, actor, 'npc', npcId);
  }
  async reserveActionPicture(client: PoolClient, state: SessionState, beat: Beat, actor: Actor) {
    this.calls.push({ kind: 'action', beatId: beat.id, narration: draftNarration(beat.draft) });
    const id = randomUUID();
    await client.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, beat_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by)
       VALUES($1,$2,$3,'scene',$4,$5,$6,false,'making','A dramatic moment.',1344,768,'fake','fake-image',$2)`,
      [id, actor.actor_id, state.session.id, state.session.scene.id, beat.id, `scene:${state.session.id}`]);
    return id;
  }
  async releaseActionPicture(client: PoolClient, sessionId: string, beatId: string) {
    // The publication row is visible on the command's client but not yet on another connection while the command is open.
    const published = 'SELECT 1 FROM published_beats WHERE session_id=$1 AND id=$2';
    const publishedInside = (await client.query(published, [sessionId, beatId])).rowCount ?? 0;
    const publishedOutside = (await this.pool.query(published, [sessionId, beatId])).rowCount ?? 0;
    this.calls.push({ kind: 'release', beatId, publishedInside, publishedOutside });
    const released = await client.query(
      `WITH newest AS (SELECT id, status FROM images WHERE session_id=$1 AND beat_id=$2 AND released_at IS NULL AND status<>'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1)
       UPDATE images SET released_at=clock_timestamp() FROM newest WHERE images.id=newest.id AND newest.status IN ('making','ready') RETURNING images.id`,
      [sessionId, beatId]);
    return released.rows[0]?.id ?? null;
  }
  run(ids: string[]) {
    this.runs.push(ids);
    // A separate connection sees the rows only once the command has committed.
    this.seenAtRun.push(this.pool.query('SELECT id FROM images WHERE id = ANY($1::uuid[])', [ids]).then(result => result.rows.map(row => row.id)));
  }
}

suite('command hooks for pictures', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let pictures: StubPictures;
  let sessionId: string, ownerId: string;
  let characterIds: string[];
  let host: string;
  let provider: FakeAiProvider;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const director = (): Actor => ({ actor_id: ownerId, role: 'host', session_id: null, character_id: null });
  const player = (index: number): Actor => ({ actor_id: `player-${index}`, role: 'player', session_id: sessionId, character_id: characterIds[index]! });
  const deps = (withPictures = true): CommandDependencies => ({
    pool, provider, rollDie: () => 4,
    ...(withPictures ? { pictures, picturesEnabled: true } : {}),
  });
  const run = (value: Record<string, unknown>, actor = director(), withPictures = true, id = sessionId) =>
    executeCommand(deps(withPictures), id, actor, CommandSchema.parse({ commandId: randomUUID(), ...value }));
  const directorView = (response: CommandResponse) => {
    if (response.snapshot.role !== 'director') throw new Error('expected the director view');
    return response.snapshot as DirectorSnapshot;
  };
  const live = (snapshot: DirectorSnapshot, value: Record<string, unknown>) => ({ expectedStateRevision: snapshot.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true, ...value });
  const imageRows = async (id = sessionId) => (await pool.query('SELECT id, purpose, subject_id, status FROM images WHERE session_id=$1 ORDER BY created_at', [id])).rows;
  const readDirector = async (id = sessionId) =>
    (await app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: { origin, cookie: host } })).json() as DirectorSnapshot;
  async function createSession() {
    const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: randomUUID() } })).json();
    return created.sessionId as string;
  }
  async function goLive(id = sessionId) {
    await pool.query("UPDATE sessions SET status='live' WHERE id=$1", [id]);
    return readDirector(id);
  }
  async function insertReady(fields: { purpose: string; subjectId: string; session?: string | null; status?: string }) {
    const id = randomUUID();
    const status = fields.status ?? 'ready';
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length)
       VALUES($1,$2,$3,$4,$5,'test-limit',$6,'A face.',768,768,'fake','fake-image',$2,$7,$8,$9)`,
      [id, ownerId, fields.session === undefined ? sessionId : fields.session, fields.purpose, fields.subjectId, status,
        status === 'ready' ? 'b'.repeat(64) : null, status === 'ready' ? 'image/jpeg' : null, status === 'ready' ? 1000 : null]);
    return id;
  }
  const beatFields = (snapshot: DirectorSnapshot) => ({ beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision });
  const beatCommand = async (type: string, fields: Record<string, unknown> = {}, withPictures = true) =>
    directorView(await run({ type, ...beatFields(await readDirector()), ...fields }, director(), withPictures));
  const heldRows = async () => (await pool.query('SELECT id, beat_id, status, released_at FROM images WHERE session_id=$1 AND beat_id IS NOT NULL ORDER BY created_at', [sessionId])).rows;
  // Drives a round through player submissions, the plan, approved stakes and the lock, stopping before the script.
  async function lockedRound(kind: 'action' | 'conversation', withPictures = true) {
    const started = await goLive();
    const opened = directorView(await run({ type: 'open_beat', kind, expectedInputEpoch: started.session.inputEpoch }, director(), withPictures));
    for (const index of [0, 1]) {
      await run(kind === 'action'
        ? { type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: opened.activeBeat!.id, expectedInputEpoch: opened.session.inputEpoch, kind: 'act', text: '', intent: `Open archive mechanism ${index}`, approach: 'Careful investigation' }
        : { type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: opened.activeBeat!.id, expectedInputEpoch: opened.session.inputEpoch, kind: 'say', text: `Hello there ${index}.`, recipientNpcIds: [opened.npcs[0]!.id] },
      player(index), withPictures);
    }
    const queued = (await readDirector()).submissions.filter(submission => submission.status === 'queued').map(submission => submission.id);
    const planned = await beatCommand('plan_beat', { submissionIds: queued }, withPictures);
    await beatCommand('approve_stakes', kind === 'action' ? { classification: 'action', contracts: planned.activeBeat!.contracts } : { classification: 'ordinary', contracts: [] }, withPictures);
    return beatCommand('lock_beat', {}, withPictures);
  }
  async function actionRound(withPictures = true) {
    await lockedRound('action', withPictures);
    return beatCommand('render_beat', {}, withPictures);
  }
  const publish = (snapshot: DirectorSnapshot, withPictures = true) =>
    beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }, withPictures);
  async function useLobbySetup() {
    const setup = { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: randomUUID(), version: 1 } };
    await pool.query('UPDATE sessions SET setup=$2 WHERE id=$1', [sessionId, setup]);
  }
  async function characterData(index: number) {
    return (await pool.query('SELECT data FROM characters WHERE session_id=$1 AND id=$2', [sessionId, characterIds[index]])).rows[0].data;
  }
  async function cardFor(index: number, portraitId?: string) {
    const data = await characterData(index);
    return { schemaVersion: 1, displayName: data.displayName, traits: data.traits, appearance: 'Tall, with a grey coat.', ...(portraitId ? { portraitId } : {}) };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
  });
  beforeEach(async () => {
    pictures = new StubPictures(pool);
    provider = new FakeAiProvider();
    sessionId = await createSession();
    ownerId = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [sessionId])).rows[0].owner_id;
    characterIds = (await pool.query('SELECT id FROM characters WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(row => row.id);
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('reserves the opening scene picture when a rehearsal goes live and runs it only after commit', async () => {
    const before = await readDirector();
    const response = await run({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: before.session.inputEpoch });
    const view = directorView(response);
    expect(pictures.calls).toEqual([{ kind: 'scene', sceneId: before.session.scene.id }]);
    const rows = await imageRows();
    expect(rows).toHaveLength(1);
    expect(pictures.runs).toEqual([[rows[0].id]]);
    expect(await pictures.seenAtRun[0]).toEqual([rows[0].id]);
    expect(view.picturesEnabled).toBe(true);
    expect(view.scenePictureStatus).toMatchObject({ sceneId: before.session.scene.id, state: 'making' });

    // The same session without pictures reaches the same state revision.
    const otherId = await createSession();
    const other = await readDirector(otherId);
    const plain = directorView(await run({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: other.session.inputEpoch }, director(), false, otherId));
    expect(plain.session.stateRevision).toBe(view.session.stateRevision);
    expect(plain.picturesEnabled).toBe(false);
    expect(plain.scenePictureStatus).toBeNull();
    expect(await imageRows(otherId)).toEqual([]);
  });

  it('reserves nothing when a command is replayed', async () => {
    const before = await readDirector();
    const command = CommandSchema.parse({ type: 'open_beat', commandId: randomUUID(), kind: 'conversation', expectedInputEpoch: before.session.inputEpoch });
    const first = await executeCommand(deps(), sessionId, director(), command);
    const replay = await executeCommand(deps(), sessionId, director(), command);
    expect(replay).toEqual(first);
    expect(pictures.calls).toHaveLength(1);
    expect(pictures.runs).toHaveLength(1);
    expect(await imageRows()).toHaveLength(1);
  });

  it('reserves a scene picture for the lobby-to-live status change but not for later status changes', async () => {
    const before = await readDirector();
    const started = directorView(await run({ type: 'set_status', status: 'live', expectedStateRevision: before.session.stateRevision }));
    expect(pictures.calls).toEqual([{ kind: 'scene', sceneId: before.session.scene.id }]);
    await run({ type: 'set_status', status: 'paused', expectedStateRevision: started.session.stateRevision });
    expect(pictures.calls).toHaveLength(1);
    expect(pictures.runs).toHaveLength(1);
  });

  it('reserves the opening picture once when a show goes lobby to paused to live', async () => {
    const before = await readDirector();
    const paused = directorView(await run({ type: 'set_status', status: 'paused', expectedStateRevision: before.session.stateRevision }));
    expect(paused.session.status).toBe('paused');
    expect(pictures.calls).toEqual([]);
    const live1 = directorView(await run({ type: 'set_status', status: 'live', expectedStateRevision: paused.session.stateRevision }));
    expect(pictures.calls).toEqual([{ kind: 'scene', sceneId: before.session.scene.id }]);
    expect(pictures.runs).toHaveLength(1);
    const paused2 = directorView(await run({ type: 'set_status', status: 'paused', expectedStateRevision: live1.session.stateRevision }));
    await run({ type: 'set_status', status: 'live', expectedStateRevision: paused2.session.stateRevision });
    expect(pictures.calls).toHaveLength(1);
    expect(pictures.runs).toHaveLength(1);
    expect(await imageRows()).toHaveLength(1);
  });

  it('reserves a picture for the new scene on change_scene', async () => {
    const before = await goLive();
    const response = directorView(await run(live(before, { type: 'change_scene', title: 'At the docks', description: 'Rain falls.', location: { kind: 'new', title: 'Docks', description: '' }, presentNpcIds: [] })));
    expect(response.session.scene.id).not.toBe(before.session.scene.id);
    expect(pictures.calls).toEqual([{ kind: 'scene', sceneId: response.session.scene.id }]);
    const rows = await imageRows();
    expect(rows.map(row => [row.purpose, row.subject_id])).toEqual([['scene', response.session.scene.id]]);
    expect(pictures.runs).toEqual([[rows[0].id]]);
    expect(response.scenePictureStatus).toMatchObject({ sceneId: response.session.scene.id, state: 'making' });
  });

  it('leaves no row and runs nothing when the command fails', async () => {
    const before = await goLive();
    await expect(run(live(before, { type: 'change_scene', title: 'Nowhere', description: '', location: { kind: 'existing', locationId: 'missing-location' }, presentNpcIds: [] }))).rejects.toThrow('That location no longer exists.');
    expect(pictures.runs).toEqual([]);
    expect(await imageRows()).toEqual([]);
  });

  it('reserves a portrait for a new NPC and ignores portraitId on create and edit', async () => {
    const before = await goLive();
    const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, ...profile } = before.npcDetails[0]!;
    const smuggled = randomUUID();
    const created = directorView(await run(live(before, { type: 'save_npc', expectedNpcVersion: 0, profile: { ...profile, displayName: 'New visitor', portraitId: smuggled } })));
    const newNpc = created.npcDetails.find(npc => !before.npcDetails.some(old => old.id === npc.id))!;
    expect(newNpc.portraitId).toBeUndefined();
    expect(pictures.calls).toEqual([{ kind: 'npc', npcId: newNpc.id }]);
    const rows = await imageRows();
    expect(rows.map(row => [row.purpose, row.subject_id])).toEqual([['npc', newNpc.id]]);
    expect(pictures.runs).toEqual([[rows[0].id]]);

    const stored = await insertReady({ purpose: 'npc', subjectId: before.npcDetails[0]!.id });
    await pool.query("UPDATE npcs SET data = jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2", [sessionId, before.npcDetails[0]!.id, stored]);
    const current = await readDirector();
    const target = current.npcDetails.find(npc => npc.id === before.npcDetails[0]!.id)!;
    const edited = directorView(await run(live(current, { type: 'save_npc', npcId: target.id, expectedNpcVersion: target.version, profile: { ...profile, displayName: 'Renamed', portraitId: randomUUID() } })));
    const after = edited.npcDetails.find(npc => npc.id === target.id)!;
    expect(after.displayName).toBe('Renamed');
    expect(after.portraitId).toBe(stored);
    expect(pictures.calls).toHaveLength(1);
    expect(pictures.runs).toHaveLength(1);
  });

  it('puts the portrait on the character when the card is saved and clears it when the saved card has none', async () => {
    await useLobbySetup();
    const portrait = await insertReady({ purpose: 'character', subjectId: characterIds[0]! });
    await run({ type: 'save_character', expectedCharacterRevision: 0, card: await cardFor(0, portrait) }, player(0));
    const seat = (await readDirector()).characterDetails.find(character => character.id === characterIds[0]);
    expect(seat).toMatchObject({ approved: true, portraitId: portrait, cardSource: 'player' });
    expect(seat?.draft).toBeNull();
    expect((await characterData(0)).portraitId).toBe(portrait);
    expect((await characterData(0)).draft).toBeNull();

    // A saved card is already applied, so there is nothing left to approve.
    await expect(run({ type: 'approve_character', characterId: characterIds[0], expectedCharacterRevision: 1 })).rejects.toMatchObject({ status: 409, code: 'conflict' });

    await run({ type: 'save_character', expectedCharacterRevision: 1, card: await cardFor(0) }, player(0));
    expect((await characterData(0)).portraitId).toBeUndefined();
    expect((await characterData(0)).draft).toBeNull();
    expect(pictures.calls).toEqual([]);
  });

  it('accepts only portraits that belong to this card on save_character', async () => {
    await useLobbySetup();
    const otherSessionId = await createSession();
    const own = await insertReady({ purpose: 'character', subjectId: characterIds[0]! });
    const foreign = [
      await insertReady({ purpose: 'character', subjectId: characterIds[1]! }),
      await insertReady({ purpose: 'character', subjectId: characterIds[0]!, status: 'making' }),
      await insertReady({ purpose: 'npc', subjectId: characterIds[0]! }),
      await insertReady({ purpose: 'card', subjectId: characterIds[0]!, session: null }),
      await insertReady({ purpose: 'character', subjectId: characterIds[0]!, session: otherSessionId }),
      'not-a-picture-id',
      '12345',
    ];
    for (const portraitId of foreign) {
      await expect(run({ type: 'save_character', expectedCharacterRevision: 0, card: await cardFor(0, portraitId) }, player(0))).rejects.toMatchObject({ status: 409, code: 'conflict', message: PORTRAIT_SENTENCE });
    }
    await run({ type: 'save_character', expectedCharacterRevision: 0, card: await cardFor(0, own) }, player(0));
    expect((await characterData(0)).portraitId).toBe(own);

    // A portrait on the seat's pending draft or on its current card stays usable even without a ready row behind it.
    const keptDraft = randomUUID();
    await pool.query("UPDATE characters SET data = jsonb_set(data, '{draft}', $3::jsonb) WHERE session_id=$1 AND id=$2", [sessionId, characterIds[0], JSON.stringify(await cardFor(0, keptDraft))]);
    await run({ type: 'save_character', expectedCharacterRevision: 1, card: await cardFor(0, keptDraft) }, player(0));
    expect((await characterData(0)).portraitId).toBe(keptDraft);
    expect((await characterData(0)).draft).toBeNull();
    const keptApproved = randomUUID();
    await pool.query("UPDATE characters SET data = jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2", [sessionId, characterIds[0], keptApproved]);
    await run({ type: 'save_character', expectedCharacterRevision: 2, card: await cardFor(0, keptApproved) }, player(0));
    expect((await characterData(0)).portraitId).toBe(keptApproved);
  });

  it('reserves the opening scene picture when the lobby starts the show', async () => {
    await useLobbySetup();
    const before = await readDirector();
    const started = directorView(await run({ type: 'start_session', expectedStateRevision: before.session.stateRevision, overrideUnreadyReason: 'Testing the start.' }));
    expect(started.session.status).toBe('live');
    expect(pictures.calls).toEqual([{ kind: 'scene', sceneId: before.session.scene.id }]);
    expect(pictures.runs).toHaveLength(1);
  });

  it('makes no calls and keeps picture fields empty without a pictures dependency', async () => {
    const before = await readDirector();
    const opened = directorView(await run({ type: 'set_status', status: 'live', expectedStateRevision: before.session.stateRevision }, director(), false));
    const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, ...profile } = before.npcDetails[0]!;
    const changed = directorView(await run(live(opened, { type: 'change_scene', title: 'At the docks', description: 'Rain falls.', location: { kind: 'new', title: 'Docks', description: '' }, presentNpcIds: [] }), director(), false));
    await run(live(changed, { type: 'save_npc', expectedNpcVersion: 0, profile: { ...profile, displayName: 'New visitor', status: 'offstage' } }), director(), false);
    expect(opened.picturesEnabled).toBe(false);
    expect(opened.scenePicture).toBeNull();
    expect(pictures.calls).toEqual([]);
    expect(pictures.runs).toEqual([]);
    expect(await imageRows()).toEqual([]);
  });
  it('reserves an action picture once the render drafts the script and runs it only after commit', async () => {
    const rendered = await actionRound();
    const beatId = rendered.activeBeat!.id;
    expect(rendered.activeBeat!.phase).toBe('draft_review');
    expect(pictures.calls).toEqual([{ kind: 'action', beatId, narration: draftNarration(rendered.activeBeat!.draft) }]);
    expect(draftNarration(rendered.activeBeat!.draft)).not.toBe('');
    const rows = await heldRows();
    expect(rows).toMatchObject([{ beat_id: beatId, status: 'making', released_at: null }]);
    expect(pictures.runs).toEqual([[rows[0].id]]);
    expect(await pictures.seenAtRun[0]).toEqual([rows[0].id]);
  });

  it('reserves again only when a new render changes the narration, and not for a replayed render', async () => {
    const rendered = await actionRound();
    const again = await beatCommand('render_beat');
    expect(draftNarration(again.activeBeat!.draft)).toBe(draftNarration(rendered.activeBeat!.draft));
    expect(again.activeBeat!.draftRevision).toBe(rendered.activeBeat!.draftRevision + 1);
    expect(pictures.calls).toHaveLength(1);

    const replayed = CommandSchema.parse({ type: 'render_beat', commandId: randomUUID(), ...beatFields(again) });
    provider = new ChangingProvider();
    const first = await executeCommand(deps(), sessionId, director(), replayed);
    const changed = directorView(first);
    expect(draftNarration(changed.activeBeat!.draft)).toMatch(/Take 1\.$/);
    expect(pictures.calls).toHaveLength(2);
    expect(pictures.calls[1]).toEqual({ kind: 'action', beatId: rendered.activeBeat!.id, narration: draftNarration(changed.activeBeat!.draft) });
    expect(await executeCommand(deps(), sessionId, director(), replayed)).toEqual(first);
    expect(pictures.calls).toHaveLength(2);
    expect(pictures.runs).toHaveLength(2);
  });

  it('reserves for a manual script on a locked round and for an edit that changes the narration, but not for a dialogue-only edit', async () => {
    const locked = await lockedRound('action');
    const beatId = locked.activeBeat!.id;
    const npcId = locked.npcs[0]!.id;
    const segments = [
      { kind: 'narration', text: 'The archive door grinds open.', delivery: 'neutral', recipientCharacterIds: [] },
      { kind: 'npc_dialogue', speakerNpcId: npcId, text: 'Careful now.', delivery: 'neutral', recipientCharacterIds: [] },
    ];
    await beatCommand('edit_script', { segments });
    expect(pictures.calls).toEqual([{ kind: 'action', beatId, narration: 'The archive door grinds open.' }]);

    await beatCommand('edit_script', { segments: [segments[0], { ...segments[1], text: 'Mind the dust.' }] });
    expect(pictures.calls).toHaveLength(1);

    await beatCommand('edit_script', { segments: [{ ...segments[0], text: 'The archive door jams halfway.' }, segments[1]] });
    expect(pictures.calls).toEqual([
      { kind: 'action', beatId, narration: 'The archive door grinds open.' },
      { kind: 'action', beatId, narration: 'The archive door jams halfway.' },
    ]);
    expect(pictures.runs).toHaveLength(2);
    expect(await heldRows()).toHaveLength(2);
  });

  it('reserves nothing for a replayed edit_script', async () => {
    const locked = await lockedRound('action');
    const command = CommandSchema.parse({ type: 'edit_script', commandId: randomUUID(), ...beatFields(locked), segments: [{ kind: 'narration', text: 'The lock gives way.', delivery: 'neutral', recipientCharacterIds: [] }] });
    const first = await executeCommand(deps(), sessionId, director(), command);
    expect(await executeCommand(deps(), sessionId, director(), command)).toEqual(first);
    expect(pictures.calls).toHaveLength(1);
    expect(pictures.runs).toHaveLength(1);
    expect(await heldRows()).toHaveLength(1);
  });

  it('reserves nothing when the render fails', async () => {
    await lockedRound('action');
    provider = new FailingProvider();
    const failed = await beatCommand('render_beat');
    expect(failed.activeBeat!.lastError).toMatch(/Generation failed/);
    expect(failed.activeBeat!.draft).toBeNull();
    expect(pictures.calls).toEqual([]);
    expect(pictures.runs).toEqual([]);
    expect(await heldRows()).toEqual([]);
  });

  it('reserves nothing for a render that a manual script superseded', async () => {
    const locked = await lockedRound('action');
    const gated = new GatedProvider();
    provider = gated;
    const rendering = run({ type: 'render_beat', ...beatFields(locked) });
    for (let tries = 0; tries < 100 && !(await pool.query("SELECT 1 FROM generation_jobs WHERE beat_id=$1 AND task='render' AND status='running'", [locked.activeBeat!.id])).rowCount; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    provider = new FakeAiProvider();
    await beatCommand('edit_script', { segments: [{ kind: 'narration', text: 'The director tells it by hand.', delivery: 'neutral', recipientCharacterIds: [] }] });
    gated.open();
    await expect(rendering).rejects.toMatchObject({ status: 409, code: 'superseded' });
    expect(pictures.calls).toEqual([{ kind: 'action', beatId: locked.activeBeat!.id, narration: 'The director tells it by hand.' }]);
    expect(pictures.runs).toHaveLength(1);
  });

  it('releases the round picture inside the publish command', async () => {
    const rendered = await actionRound();
    const beatId = rendered.activeBeat!.id;
    const published = await publish(rendered);
    expect(published.activeBeat).toBeNull();
    expect(pictures.calls.at(-1)).toEqual({ kind: 'release', beatId, publishedInside: 1, publishedOutside: 0 });
    const rows = await heldRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].released_at).toBeInstanceOf(Date);
    expect(pictures.runs).toHaveLength(1);
  });

  it('reserves an opening picture when the only picture of the scene is a held action picture', async () => {
    const before = await goLive();
    await pool.query("UPDATE images SET status='failed' WHERE session_id=$1 AND purpose='scene'", [sessionId]);
    await actionRound();
    expect(await heldRows()).toHaveLength(1);
    const callsBefore = pictures.calls.length;
    const paused = directorView(await run({ type: 'set_status', status: 'paused', expectedStateRevision: (await readDirector()).session.stateRevision }));
    await run({ type: 'set_status', status: 'live', expectedStateRevision: paused.session.stateRevision });
    expect(pictures.calls.slice(callsBefore)).toEqual([{ kind: 'scene', sceneId: before.session.scene.id }]);
  });

  it('keeps a released action picture off the stage when the director hid the scene picture before publishing', async () => {
    // The hide route exists only in an app with a picture provider; it is booted first because starting an app fails stale making rows.
    const picturesApp = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, images: new FakeImageProvider({}) });
    try {
    const picturesHost = cookie(await picturesApp.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const rendered = await actionRound();
    const held = (await heldRows())[0];
    await pool.query("UPDATE images SET status='ready', file_hash=$2, content_type='image/jpeg', byte_length=1000 WHERE id=$1", [held.id, 'c'.repeat(64)]);
    const hidden = await picturesApp.inject({ method: 'POST', url: `/api/sessions/${sessionId}/scene-picture/hide`, headers: { origin, cookie: picturesHost } });
    expect(hidden.statusCode).toBeLessThan(300);
    await publish(rendered);
    expect((await heldRows())[0].released_at).toBeInstanceOf(Date);
    const stage: Actor = { actor_id: 'stage-1', role: 'stage', session_id: sessionId, character_id: null };
    const client = await pool.connect();
    try {
      expect((await project(client, sessionId, stage, undefined, { picturesEnabled: true })).scenePicture).toBeNull();
      const row = (await client.query<ImageRow>('SELECT * FROM images WHERE id=$1', [held.id])).rows[0]!;
      expect(await imageVisibleTo(client, stage, sessionId, ownerId, row)).toBe(false);
    } finally { client.release(); }
    } finally { await picturesApp.close(); }
  });

  it('releases nothing when an action round is aborted', async () => {
    await actionRound();
    await beatCommand('abort_beat', { reason: 'The players changed their minds.' });
    expect(pictures.calls.map(call => call.kind)).toEqual(['action']);
    expect((await heldRows())[0].released_at).toBeNull();
  });

  it('never reserves or releases for a conversation round', async () => {
    await lockedRound('conversation');
    const rendered = await beatCommand('render_beat');
    expect(rendered.activeBeat!.kind).toBe('conversation');
    const edited = await beatCommand('edit_script', { segments: [{ kind: 'narration', text: 'A quiet word is shared.', delivery: 'neutral', recipientCharacterIds: [] }] });
    await publish(edited);
    expect(pictures.calls).toEqual([]);
    expect(pictures.runs).toEqual([]);
    expect(await heldRows()).toEqual([]);
  });

  it('makes no picture calls for an action round without a pictures dependency', async () => {
    const rendered = await actionRound(false);
    await beatCommand('edit_script', { segments: [{ kind: 'narration', text: 'A different ending.', delivery: 'neutral', recipientCharacterIds: [] }] }, false);
    await publish(await readDirector(), false);
    expect(rendered.activeBeat!.kind).toBe('action');
    expect(pictures.calls).toEqual([]);
    expect(pictures.runs).toEqual([]);
    expect(await imageRows()).toEqual([]);
  });
});
