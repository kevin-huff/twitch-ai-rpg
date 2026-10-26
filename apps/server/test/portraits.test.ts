import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURE_MODELS, type CharacterCardDefinition, DirectorSnapshot, PlayerSnapshot, ScenarioDefinition, StageSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const IMMUTABLE = 'private, max-age=31536000, immutable';
const NOT_FOUND = 'Picture was not found.';
const NEEDS_LOOK = 'Describe how this character looks first, then press Create portrait.';
const STALE_BEFORE = 'Your card changed. Load the latest card, then try again.';
const STALE_AFTER = 'Your card changed while the portrait was being made. Load the latest card, then try again.';
const FOREIGN = 'That portrait is not available for this card. Create a new one.';
const details = (extra: Record<string, unknown> = {}) => ({ appearance: 'A tall figure in a grey coat.', role: '', pronouns: '', name: '', ...extra });

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Credential { cookie: string; identity?: string }
interface Seat extends Credential { characterId: string }

suite('seat portraits and picture access', () => {
  let app: App;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let provider: FakeImageProvider;
  let gate: Promise<void> | null;
  let hostToken: string;
  let host: Credential;
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  let sessionId: string;
  let seats: Seat[];
  let stageInvite: Credential;
  const open: App[] = [];

  const cookieOf = (headers: Record<string, unknown>) => {
    const values = headers['set-cookie'];
    return String(Array.isArray(values) ? values[0] : values).split(';')[0]!;
  };
  const call = (url: string, payload?: Record<string, unknown>, credential: Credential = host, headers: Record<string, string> = {}, target: App = app) => target.inject({
    method: payload === undefined ? 'GET' : 'POST', url,
    headers: { origin, ...(credential.cookie ? { cookie: credential.cookie } : {}), ...(credential.identity ? { 'x-rpg-identity': credential.identity } : {}), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  const portrait = (payload: Record<string, unknown>, credential: Credential = seats[0]!, id = sessionId) => call(`/api/sessions/${id}/character/portrait`, payload, credential);
  const seatBody = (revision: number, extra: Record<string, unknown> = {}) => ({ expectedCharacterRevision: revision, details: details(extra) });
  const command = (payload: Record<string, unknown>, credential: Credential = host, id = sessionId) => call(`/api/sessions/${id}/commands`, { commandId: randomUUID(), ...payload }, credential);
  const succeed = async (payload: Record<string, unknown>, credential: Credential = host) => {
    const response = await command(payload, credential);
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  const director = async () => (await call(`/api/sessions/${sessionId}`)).json() as DirectorSnapshot;
  const own = async (index: number) => (await call(`/api/sessions/${sessionId}`, undefined, seats[index]!)).json() as PlayerSnapshot;
  const stageView = async (credential: Credential) => (await call(`/api/sessions/${sessionId}?view=stage`, undefined, credential)).json() as StageSnapshot;
  const revisionOf = async (index: number) => (await own(index)).ownCharacter!.cardRevision;
  const imageRows = async (id = sessionId) => (await pool.query('SELECT id, purpose, subject_id, status FROM images WHERE session_id=$1 ORDER BY created_at', [id])).rows;
  const characterData = async (index: number) => (await pool.query('SELECT data FROM characters WHERE session_id=$1 AND id=$2', [sessionId, seats[index]!.characterId])).rows[0].data;
  const saveCard = (index: number, revision: number, portraitId?: string) => command({
    type: 'save_character', expectedCharacterRevision: revision,
    card: { ...starter.characters[index]!, ...(portraitId ? { portraitId } : {}) },
  }, seats[index]);
  async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async function boot(images: FakeImageProvider | null) {
    const built = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(images ? { images } : {}) });
    open.push(built);
    return built;
  }
  async function createSession(target: App, scenario: ScenarioDefinition | null, signedIn: Credential) {
    let body: Record<string, unknown> = { commandId: randomUUID() };
    if (scenario) {
      const saved = (await call('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: scenario }, signedIn, {}, target)).json();
      const characters = [];
      for (const definition of starter.characters.slice(0, 2)) {
        const template = (await call('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition }, signedIn, {}, target)).json();
        characters.push({ templateId: template.id, version: template.version });
      }
      body = { ...body, scenario: { templateId: saved.id, version: saved.version }, characters };
    }
    const created = await call('/api/sessions', body, signedIn, {}, target);
    expect(created.statusCode, created.body).toBe(200);
    const players: Seat[] = [];
    let stage: Credential | undefined;
    for (const invite of created.json().invites as Array<{ role: string; token: string; characterId: string | null }>) {
      const redeemed = await call('/api/auth/redeem', { token: invite.token }, { cookie: '' }, {}, target);
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      if (invite.role === 'player') players.push({ cookie: cookieOf(redeemed.headers), characterId: invite.characterId! });
      else stage = { cookie: cookieOf(redeemed.headers) };
    }
    return { sessionId: created.json().sessionId as string, players, stage: stage! };
  }
  // The credential an OBS browser source gets: a stream link token traded for a tab cookie and identity.
  async function streamCredential(id = sessionId, signedIn: Credential = host, target: App = app): Promise<Credential> {
    const made = await call(`/api/sessions/${id}/stream-links`, { commandId: randomUUID(), subject: 'show' }, signedIn, {}, target);
    expect(made.statusCode, made.body).toBe(200);
    const exchanged = await call('/api/stream/access', { token: made.json().token }, { cookie: '' }, {}, target);
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    return { cookie: cookieOf(exchanged.headers), identity: exchanged.json().identityId };
  }
  const withIdentity = (url: string, credential: Credential) => credential.identity ? `${url}?identity=${credential.identity}` : url;
  const image = (imageId: string, credential: Credential, id = sessionId) => call(withIdentity(`/api/sessions/${id}/images/${imageId}`, credential), undefined, { cookie: credential.cookie });
  async function startShow() {
    for (const character of (await director()).characterDetails) {
      if (character.approved && !character.draft) continue;
      await succeed({ type: 'approve_character', characterId: character.id, expectedCharacterRevision: character.cardRevision });
    }
    await succeed({ type: 'start_session', expectedStateRevision: (await director()).session.stateRevision, overrideUnreadyReason: 'Testing a started show.' });
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-portraits-'));
  });
  afterAll(async () => {
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    hostToken = `portraits-test-${randomUUID()}`;
    gate = null;
    provider = new FakeImageProvider({ hold: () => gate ?? Promise.resolve() });
    app = await boot(provider);
    const signedIn = await call('/api/auth/host', { token: hostToken }, { cookie: '' });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    host = { cookie: cookieOf(signedIn.headers) };
    starter = (await call('/api/library/starter')).json();
    const created = await createSession(app, starter.scenario, host);
    sessionId = created.sessionId; seats = created.players; stageInvite = created.stage;
  });
  afterEach(async () => {
    gate = null;
    for (const built of open.splice(0)) await built.close().catch(() => undefined);
  });

  it('lets only the seat player ask for a portrait, before the show starts, and answers with the picture id', async () => {
    const before = provider.requests.length;
    expect((await portrait(seatBody(0), { cookie: '' })).statusCode).toBe(401);
    for (const other of [host, stageInvite]) {
      const refused = await portrait(seatBody(0), other);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'forbidden', message: 'Use your own player seat to write a card.' });
    }
    expect((await portrait(seatBody(0), await streamCredential())).statusCode).toBe(403);
    expect((await portrait({ ...seatBody(0), extra: 'forged' })).statusCode).toBe(400);
    expect((await portrait({ details: details() })).statusCode).toBe(400);
    expect((await portrait(seatBody(0, { surprise: 'x' }))).statusCode).toBe(400);
    expect(provider.requests).toHaveLength(before);
    expect(await imageRows()).toEqual([]);

    const made = await portrait(seatBody(0, { role: 'Breaks codes', name: 'Ada Quill', appearance: 'Ada Quill wears a grey coat.' }));
    expect(made.statusCode, made.body).toBe(200);
    expect(Object.keys(made.json())).toEqual(['imageId']);
    const [row] = await imageRows();
    expect(row).toMatchObject({ id: made.json().imageId, purpose: 'character', subject_id: seats[0]!.characterId, status: 'ready' });
    expect(provider.requests).toHaveLength(before + 1);
    const prompt = provider.requests.at(-1)!.prompt;
    expect(prompt).toContain('grey coat');
    expect(prompt).toContain('Breaks codes');
    expect(prompt).not.toContain('Ada Quill');

    // Role alone is enough to draw; a name or pronouns alone are not.
    expect((await portrait(seatBody(0, { appearance: '', role: 'A ferry captain' }))).statusCode).toBe(200);
    const bare = await portrait(seatBody(0, { appearance: '  ', role: ' ', pronouns: 'she/her', name: 'Ada Quill' }));
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json()).toMatchObject({ code: 'invalid_input', message: NEEDS_LOOK });
    expect(provider.requests).toHaveLength(before + 2);
    expect(await imageRows()).toHaveLength(2);

    // Drawing never changes the card or the show.
    expect(await revisionOf(0)).toBe(0);
    expect((await director()).session.stateRevision).toBe(0);
  });

  it('draws a seat portrait with the show\'s saved style and model', async () => {
    const model = PICTURE_MODELS[2]!.id;
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Charcoal sketch', model })]);
    const made = await portrait(seatBody(0));
    expect(made.statusCode, made.body).toBe(200);
    const row = (await pool.query('SELECT model FROM images WHERE id=$1', [made.json().imageId])).rows[0];
    expect(row.model).toBe(model);
    expect(provider.requests.at(-1)!.prompt.startsWith('Charcoal sketch. ')).toBe(true);
  });

  it('gives library portraits the request\'s model for a non-player character and the defaults for a card', async () => {
    const model = PICTURE_MODELS[2]!.id;
    const libraryBody = (extra: Record<string, unknown>) => ({ subjectKey: 'key-1', details: details(), ...extra });
    const modelOf = async (id: string) => (await pool.query('SELECT model FROM images WHERE id=$1', [id])).rows[0].model;
    const withModel = await call('/api/library/portraits', libraryBody({ subject: 'npc', pictureStyle: 'Ink wash', pictureModel: model }));
    expect(withModel.statusCode, withModel.body).toBe(200);
    expect(await modelOf(withModel.json().imageId)).toBe(model);
    expect(provider.requests.at(-1)!.prompt.startsWith('Ink wash. ')).toBe(true);
    const without = await call('/api/library/portraits', libraryBody({ subject: 'npc', subjectKey: 'key-2' }));
    expect(without.statusCode, without.body).toBe(200);
    expect(await modelOf(without.json().imageId)).toBe('fake-image');
    const card = await call('/api/library/portraits', libraryBody({ subject: 'card', subjectKey: 'key-3', pictureStyle: 'Ink wash' }));
    expect(card.statusCode, card.body).toBe(200);
    expect(await modelOf(card.json().imageId)).toBe('fake-image');
    expect(provider.requests.at(-1)!.prompt).not.toContain('Ink wash');
  });

  it('records the producer grant of a seat opened through a producer, and null for a normal seat', async () => {
    const grant = (await call('/api/producers', { commandId: randomUUID(), label: 'Night producer' })).json().producer.id as string;
    const opened = await call(`/api/sessions/${sessionId}/test-seat`, { characterId: seats[0]!.characterId });
    expect(opened.statusCode, opened.body).toBe(200);
    const testSeat: Seat = { cookie: cookieOf(opened.headers), identity: opened.json().identityId, characterId: seats[0]!.characterId };
    // The test seat copies the opener's grant; the host here has none, so attach one the way a producer-opened seat carries it.
    const updated = await pool.query('UPDATE credentials SET producer_grant_id=$1 WHERE token_hash=$2', [grant, hash(testSeat.cookie.split('=')[1]!)]);
    expect(updated.rowCount).toBe(1);
    const viaProducer = await portrait(seatBody(0), testSeat);
    expect(viaProducer.statusCode, viaProducer.body).toBe(200);
    const normal = await portrait(seatBody(0));
    expect(normal.statusCode, normal.body).toBe(200);
    const rows = (await pool.query('SELECT id, producer_grant_id FROM images WHERE session_id=$1', [sessionId])).rows;
    expect(rows.find(row => row.id === viaProducer.json().imageId).producer_grant_id).toBe(grant);
    expect(rows.find(row => row.id === normal.json().imageId).producer_grant_id).toBeNull();
  });

  it('refuses a stale card before drawing, and in a rehearsal or a started show', async () => {
    const stale = await portrait(seatBody(3));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', message: STALE_BEFORE });
    expect(provider.requests).toHaveLength(0);
    expect(await imageRows()).toEqual([]);

    const rehearsal = await createSession(app, null, host);
    const noLobby = await portrait(seatBody(0), rehearsal.players[0]!, rehearsal.sessionId);
    expect(noLobby.statusCode, noLobby.body).toBe(409);
    expect(noLobby.json().message).toBe('This session uses the original rehearsal cast rather than an editable lobby.');

    await startShow();
    const started = await portrait(seatBody(0));
    expect(started.statusCode, started.body).toBe(409);
    expect(started.json().message).toBe('Cards can only change before the show starts.');
    // The only picture the show has is its opening scene.
    expect((await imageRows()).filter(row => row.purpose === 'character')).toEqual([]);
    expect(provider.requests.every(request => !request.prompt.includes('Head-and-shoulders'))).toBe(true);
  });

  it('checks the card again after the picture is made and refuses if it changed meanwhile', async () => {
    let release!: () => void;
    gate = new Promise<void>(resolve => { release = resolve; });
    const pending = portrait(seatBody(0));
    await waitFor(() => provider.requests.length === 1, 'the held portrait to reach the provider');
    expect((await saveCard(0, 0)).statusCode).toBe(200);
    release();
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', message: STALE_AFTER });
    expect(await revisionOf(0)).toBe(1);
    // The picture was still made, so a retry on the new card can ask again and gets its own.
    expect((await imageRows()).map(row => row.status)).toEqual(['ready']);
    gate = null;
    const retry = await portrait(seatBody(1));
    expect(retry.statusCode, retry.body).toBe(200);
  });

  it('accepts a fresh portrait when the card is saved and refuses a portrait that is not this character\'s', async () => {
    const mine = (await portrait(seatBody(0))).json().imageId as string;
    const theirs = (await portrait(seatBody(0), seats[1]!)).json().imageId as string;
    for (const foreign of [randomUUID(), theirs, mine.toUpperCase()]) {
      const refused = await saveCard(0, 0, foreign);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: FOREIGN });
    }
    expect(await revisionOf(0)).toBe(0);
    expect((await saveCard(0, 0, mine)).statusCode).toBe(200);
    expect((await characterData(0)).draft.portraitId).toBe(mine);
    expect(await revisionOf(0)).toBe(1);
    // The saved draft keeps it, so saving the card again with the same portrait stays allowed.
    expect((await saveCard(0, 1, mine)).statusCode).toBe(200);
    expect((await characterData(0)).draft.portraitId).toBe(mine);
  });

  it('copies the portrait to the public character on approval and clears it when the card is saved without one', async () => {
    const made = (await portrait(seatBody(0))).json().imageId as string;
    await succeed({ type: 'save_character', expectedCharacterRevision: 0, card: { ...starter.characters[0]!, portraitId: made } }, seats[0]);
    const card = (await director()).characterDetails.find(item => item.id === seats[0]!.characterId)!;
    expect(card.draft?.portraitId).toBe(made);
    expect(card.portraitId).toBeUndefined();
    // The stage lists only approved characters, so a draft portrait is not there at all.
    const snapshot = async () => (await stageView(stageInvite)).characters.find(item => item.id === seats[0]!.characterId);
    expect(await snapshot()).toBeUndefined();

    await succeed({ type: 'approve_character', characterId: card.id, expectedCharacterRevision: card.cardRevision });
    expect((await characterData(0)).portraitId).toBe(made);
    expect((await characterData(0)).draft).toBeNull();
    expect((await snapshot())!.portraitId).toBe(made);

    // A card saved without a portrait removes it once approved again; the old one stays on the character until then.
    const approved = (await director()).characterDetails.find(item => item.id === card.id)!;
    await succeed({ type: 'save_character', expectedCharacterRevision: approved.cardRevision, card: starter.characters[0]! }, seats[0]);
    expect((await characterData(0)).portraitId).toBe(made);
    const redraft = (await director()).characterDetails.find(item => item.id === card.id)!;
    expect(redraft.draft).not.toBeNull();
    expect(redraft.draft?.portraitId).toBeUndefined();
    await succeed({ type: 'approve_character', characterId: card.id, expectedCharacterRevision: redraft.cardRevision });
    expect(await characterData(0)).not.toHaveProperty('portraitId');
    expect(await snapshot()).toMatchObject({ approved: true });
    expect((await snapshot())!.portraitId).toBeUndefined();
  });

  it('shows each picture only to the people who may see it', async () => {
    const stage = await streamCredential();
    const first = (await portrait(seatBody(0))).json().imageId as string;
    const second = (await portrait(seatBody(0), seats[1]!)).json().imageId as string;

    // A fresh portrait belongs to the player who made it, plus the director.
    expect((await image(first, seats[0]!)).statusCode).toBe(200);
    expect((await image(first, host)).statusCode).toBe(200);
    for (const outsider of [seats[1]!, stage, stageInvite]) {
      const hidden = await image(first, outsider);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toMatchObject({ message: NOT_FOUND });
    }

    // A saved draft is still private to its player and the director.
    expect((await saveCard(0, 0, first)).statusCode).toBe(200);
    expect((await saveCard(1, 0, second)).statusCode).toBe(200);
    expect((await image(first, seats[0]!)).statusCode).toBe(200);
    expect((await image(second, seats[1]!)).statusCode).toBe(200);
    expect((await image(first, seats[1]!)).statusCode).toBe(404);
    expect((await image(second, seats[0]!)).statusCode).toBe(404);
    expect((await image(first, stage)).statusCode).toBe(404);

    // Approval makes it public to the whole table and the stage.
    const card = (await director()).characterDetails.find(item => item.id === seats[0]!.characterId)!;
    await succeed({ type: 'approve_character', characterId: card.id, expectedCharacterRevision: card.cardRevision });
    for (const viewer of [stage, stageInvite, seats[1]!, seats[0]!]) expect((await image(first, viewer)).statusCode).toBe(200);
    expect((await image(second, stage)).statusCode).toBe(404);

    const served = await image(first, stage);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe(IMMUTABLE);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('serves the scene picture and non-player portraits to the stage, and hides a hidden scene picture', async () => {
    const stage = await streamCredential();
    const approvedPortrait = (await portrait(seatBody(0))).json().imageId as string;
    await succeed({ type: 'save_character', expectedCharacterRevision: 0, card: { ...starter.characters[0]!, portraitId: approvedPortrait } }, seats[0]);
    await startShow();

    await waitFor(async () => (await stageView(stage)).scenePicture !== null, 'the scene picture');
    const scene = (await stageView(stage)).scenePicture!;
    const view = await director();
    const npcId = view.npcDetails[0]!.id;
    const made = await call(`/api/sessions/${sessionId}/npcs/${npcId}/portrait`, {});
    expect(made.statusCode, made.body).toBe(202);
    const npcPortrait = made.json().imageId as string;
    await waitFor(async () => (await pool.query("SELECT 1 FROM npcs WHERE session_id=$1 AND data->>'portraitId'=$2", [sessionId, npcPortrait])).rowCount === 1, 'the NPC portrait to attach');

    for (const viewer of [stage, stageInvite, seats[0]!, seats[1]!, host]) {
      expect((await image(scene.imageId, viewer)).statusCode, 'scene picture').toBe(200);
      expect((await image(npcPortrait, viewer)).statusCode, 'NPC portrait').toBe(200);
      expect((await image(approvedPortrait, viewer)).statusCode, 'approved character portrait').toBe(200);
    }
    expect((await image(scene.imageId, stage)).headers['cache-control']).toBe(IMMUTABLE);

    // A hidden scene picture is gone for the audience and the players, and still there for the director.
    await call(`/api/sessions/${sessionId}/scene-picture/hide`, {});
    for (const viewer of [stage, stageInvite, seats[0]!]) {
      const gone = await image(scene.imageId, viewer);
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ message: NOT_FOUND });
      expect(gone.headers['cache-control']).toBe('no-store');
    }
    expect((await image(scene.imageId, host)).statusCode).toBe(200);
    expect((await image(npcPortrait, stage)).statusCode).toBe(200);
    await call(`/api/sessions/${sessionId}/scene-picture/show`, {});
    expect((await image(scene.imageId, stage)).statusCode).toBe(200);

    // Another session's credentials get nothing, and neither does this session's stage for a picture from elsewhere.
    const other = await createSession(app, null, host);
    const otherStage = await streamCredential(other.sessionId);
    for (const viewer of [otherStage, other.stage, other.players[0]!]) {
      expect((await image(scene.imageId, viewer, sessionId)).statusCode).toBe(404);
      expect((await image(scene.imageId, viewer, other.sessionId)).statusCode).toBe(404);
      expect((await image(npcPortrait, viewer, other.sessionId)).statusCode).toBe(404);
    }
    expect((await image(scene.imageId, stage, other.sessionId)).statusCode).toBe(404);
  });

  it('answers 404 with the plain sentence for ids that are not a picture', async () => {
    const stage = await streamCredential();
    for (const bad of ['not-an-id', '12345', 'ABCDEF01-0000-4000-8000-000000000000', `${randomUUID()}x`, randomUUID()]) {
      for (const viewer of [host, stage, seats[0]!]) {
        const response = await image(bad, viewer);
        expect(response.statusCode, bad).toBe(404);
        expect(response.json()).toMatchObject({ message: NOT_FOUND });
      }
      const library = await call(`/api/library/images/${bad}`);
      expect(library.statusCode, bad).toBe(404);
      expect(library.json()).toMatchObject({ message: NOT_FOUND });
    }
  });

  it('keeps serving pictures but refuses new portraits when pictures are off', async () => {
    const made = (await portrait(seatBody(0))).json().imageId as string;
    const off = await boot(null);
    const offSession = await createSession(off, starter.scenario, host);
    const refused = await call(`/api/sessions/${offSession.sessionId}/character/portrait`, seatBody(0), offSession.players[0]!, {}, off);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'pictures_off', message: 'Pictures are off on this server.' });
    // Images made earlier stay readable, here through the same database.
    expect((await call(`/api/sessions/${sessionId}/images/${made}`, undefined, host, {}, off)).statusCode).toBe(200);
  });
});
