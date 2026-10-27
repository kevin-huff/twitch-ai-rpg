import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PICTURE_STYLE, type CharacterCardDefinition, type DirectorSnapshot, type ScenarioDefinition } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const IMMUTABLE = 'private, max-age=31536000, immutable';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOT_FOUND = 'Picture was not found.';
const NEEDS_LOOK = 'Describe how this character looks first, then press Create portrait.';
const NEEDS_LOOK_OR_ROLE = 'Give this character an appearance or a role first.';
const HOST_ONLY = 'Only the host can manage reusable templates.';
const FOREIGN = 'That portrait is not available for this card. Create a new one.';
const STALE_DRAFT = 'This draft changed. Reload it before generating.';
const SUBMITTED = 'This character has already been submitted. It is now read-only.';
const HOURLY = /^The picture limit for this hour is used up\. Try again in (1 minute|\d+ minutes)\.$/;
const details = (extra: Record<string, unknown> = {}) => ({ appearance: 'A tall figure in a grey coat.', role: '', pronouns: '', name: '', ...extra });
const blankDraft = () => ({
  schemaVersion: 1 as const, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '',
  traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: ['', '', ''],
  connection: '', secret: '', extensions: {},
});

type App = Awaited<ReturnType<typeof buildApp>>;
interface Credential { cookie: string; identity?: string }

suite('builder and library portraits', () => {
  let app: App;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let provider: FakeImageProvider;
  let gate: Promise<void> | null;
  let hostToken: string;
  let host: Credential;
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  const open: App[] = [];

  const cookieOf = (headers: Record<string, unknown>) => {
    const values = headers['set-cookie'];
    return String(Array.isArray(values) ? values[0] : values).split(';')[0]!;
  };
  const call = (url: string, payload?: Record<string, unknown>, credential: Credential = host, target: App = app) => target.inject({
    method: payload === undefined ? 'GET' : 'POST', url,
    headers: { origin, ...(credential.cookie ? { cookie: credential.cookie } : {}), ...(credential.identity ? { 'x-rpg-identity': credential.identity } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });
  async function boot(images: FakeImageProvider | null, extra: { imageHourlyLimit?: number; hostToken?: string } = {}) {
    const built = await buildApp({ databaseUrl: databaseUrl!, hostToken: extra.hostToken ?? hostToken, origin, serveStatic: false, assetDir, ...(images ? { images } : {}), ...(extra.imageHourlyLimit ? { imageHourlyLimit: extra.imageHourlyLimit } : {}) });
    open.push(built);
    return built;
  }
  async function signIn(target: App, token: string): Promise<Credential> {
    const signedIn = await call('/api/auth/host', { token }, { cookie: '' }, target);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    return { cookie: cookieOf(signedIn.headers) };
  }
  // A private character link, traded for the cookie and identity the builder screen sends.
  async function builderLink(signedIn: Credential = host, target: App = app) {
    const made = await call('/api/character-builders', { commandId: randomUUID(), label: 'A player', instructions: '' }, signedIn, target);
    expect(made.statusCode, made.body).toBe(200);
    const exchanged = await call('/api/character-builder/access', { token: made.json().token }, { cookie: '' }, target);
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const credential: Credential = { cookie: cookieOf(exchanged.headers), identity: exchanged.json().identityId };
    return { builderId: made.json().builder.id as string, credential };
  }
  const builderPortrait = (revision: number, extra: Record<string, unknown> = {}, credential: Credential, target: App = app) =>
    call('/api/character-builder/portrait', { expectedRevision: revision, details: details(extra) }, credential, target);
  const builderImage = (imageId: string, credential: Credential, target: App = app) => call(`/api/character-builder/images/${imageId}`, undefined, credential, target);
  const libraryPortrait = (payload: Record<string, unknown>, credential: Credential = host, target: App = app) => call('/api/library/portraits', payload, credential, target);
  const npcBody = (subjectKey: string, extra: Record<string, unknown> = {}, detailExtra: Record<string, unknown> = {}) => ({ subject: 'npc', subjectKey, details: details(detailExtra), ...extra });
  const cardBody = (subjectKey: string, detailExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ subject: 'card', subjectKey, details: details(detailExtra), ...extra });
  const libraryImage = (imageId: string, credential: Credential = host, target: App = app) => call(`/api/library/images/${imageId}`, undefined, credential, target);
  const imageRow = async (imageId: string) => (await pool.query('SELECT * FROM images WHERE id=$1', [imageId])).rows[0];
  const insertImage = async (status: string, builderId: string | null = null) => {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO images(id,owner_id,builder_id,purpose,subject_id,limit_key,status,prompt,width,height,provider,model,requested_by,file_hash,content_type,byte_length) VALUES($1,$2,$3,'card','card',$4,$5,'A portrait',512,512,'fake','fake-image',$2,$6,'image/png',10)",
      [id, hash(hostToken), builderId, `builder:${builderId ?? 'none'}`, status, 'a'.repeat(64)],
    );
    return id;
  };
  async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  // A seat cookie, to prove a player cannot use the host-only library routes.
  async function playerSeat(): Promise<Credential> {
    const created = await call('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const invite = (created.json().invites as Array<{ role: string; token: string }>).find(item => item.role === 'player')!;
    const redeemed = await call('/api/auth/redeem', { token: invite.token }, { cookie: '' });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    return { cookie: cookieOf(redeemed.headers) };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-library-portraits-'));
  });
  afterAll(async () => {
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    hostToken = `library-portraits-test-${randomUUID()}`;
    gate = null;
    provider = new FakeImageProvider({ hold: () => gate ?? Promise.resolve() });
    app = await boot(provider);
    // The hourly limit counts every picture on the database; test files run one at a time, so start from none.
    await pool.query('DELETE FROM images');
    host = await signIn(app, hostToken);
    starter = (await call('/api/library/starter')).json();
  });
  afterEach(async () => {
    gate = null;
    for (const built of open.splice(0)) await built.close().catch(() => undefined);
  });

  it('makes a builder portrait only for an active link with an editable draft, and answers with the picture id', async () => {
    const { builderId, credential } = await builderLink();
    const before = provider.requests.length;
    // The link cookie and the identity header are both needed.
    expect((await builderPortrait(0, {}, { cookie: '' })).statusCode).toBe(401);
    expect((await builderPortrait(0, {}, { cookie: credential.cookie })).statusCode).toBe(401);
    expect((await builderPortrait(0, {}, { ...credential, identity: 'f'.repeat(32) })).statusCode).toBe(401);
    expect((await builderPortrait(0, {}, host)).statusCode).toBe(401);
    // Strict bodies.
    expect((await call('/api/character-builder/portrait', { expectedRevision: 0, details: details(), extra: 'forged' }, credential)).statusCode).toBe(400);
    expect((await call('/api/character-builder/portrait', { details: details() }, credential)).statusCode).toBe(400);
    expect((await builderPortrait(0, { surprise: 'x' }, credential)).statusCode).toBe(400);
    // Blank details: a name or pronouns alone are not enough.
    const bare = await builderPortrait(0, { appearance: '  ', role: ' ', pronouns: 'she/her', name: 'Ada Quill' }, credential);
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.json()).toMatchObject({ code: 'invalid_input', message: NEEDS_LOOK });
    // The draft revision is checked before anything is drawn.
    const stale = await builderPortrait(4, {}, credential);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', message: STALE_DRAFT });
    expect(provider.requests).toHaveLength(before);
    expect((await pool.query('SELECT 1 FROM images')).rowCount).toBe(0);

    const made = await builderPortrait(0, { name: 'Ada Quill', appearance: 'Ada Quill wears a grey coat.', role: 'Breaks codes' }, credential);
    expect(made.statusCode, made.body).toBe(200);
    expect(Object.keys(made.json())).toEqual(['imageId']);
    expect(await imageRow(made.json().imageId)).toMatchObject({
      purpose: 'card', status: 'ready', session_id: null, builder_id: builderId, subject_id: builderId,
      limit_key: `builder:${builderId}`, requested_by: `builder:${builderId}`, owner_id: hash(hostToken),
    });
    expect(provider.requests).toHaveLength(before + 1);
    const prompt = provider.requests.at(-1)!.prompt;
    expect(prompt).toContain('grey coat');
    expect(prompt).toContain('Breaks codes');
    expect(prompt).not.toContain('Ada Quill');
    expect(prompt).toContain(DEFAULT_PICTURE_STYLE);
    // A role alone is enough to draw.
    expect((await builderPortrait(0, { appearance: '', role: 'A ferry captain' }, credential)).statusCode).toBe(200);
    // Drawing never changes the draft.
    expect((await call('/api/character-builder', undefined, credential)).json()).toMatchObject({ revision: 0, draft: blankDraft() });
  });

  it('checks the draft again after the picture is made, and refuses once the card is submitted', async () => {
    const { credential } = await builderLink();
    let release!: () => void;
    gate = new Promise<void>(resolve => { release = resolve; });
    const pending = builderPortrait(0, {}, credential);
    await waitFor(() => provider.requests.length === 1, 'the held portrait to reach the provider');
    const saved = await call('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: { ...blankDraft(), displayName: 'Changed meanwhile' } }, credential);
    expect(saved.statusCode, saved.body).toBe(200);
    release();
    const response = await pending;
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', message: STALE_DRAFT });
    // The picture was still made, so a retry on the new revision gets its own.
    expect((await pool.query("SELECT status FROM images")).rows).toEqual([{ status: 'ready' }]);
    gate = null;
    expect((await builderPortrait(1, {}, credential)).statusCode).toBe(200);

    const submitted = await call('/api/character-builder/submit', { commandId: randomUUID(), expectedRevision: 1, draft: { ...blankDraft(), displayName: 'Final' } }, credential);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const before = provider.requests.length;
    const refused = await builderPortrait(2, {}, credential);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'conflict', message: SUBMITTED });
    expect(provider.requests).toHaveLength(before);
  });

  it('refuses a builder portrait when pictures are off, and keeps serving earlier ones', async () => {
    const { credential } = await builderLink();
    const made = (await builderPortrait(0, {}, credential)).json().imageId as string;
    const off = await boot(null);
    const refused = await builderPortrait(0, {}, credential, off);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'pictures_off', message: 'Pictures are off on this server.' });
    expect((await builderImage(made, credential, off)).statusCode).toBe(200);
  });

  it('serves a builder picture only to the link it was made for', async () => {
    const first = await builderLink();
    const second = await builderLink();
    const made = (await builderPortrait(0, {}, first.credential)).json().imageId as string;

    const served = await builderImage(made, first.credential);
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe(IMMUTABLE);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.subarray(0, 8)).toEqual(PNG);

    // Another link of the same host sees nothing, and neither does anyone without the link cookie and identity.
    const hidden = await builderImage(made, second.credential);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ message: NOT_FOUND });
    expect((await builderImage(made, { cookie: '' })).statusCode).toBe(401);
    expect((await builderImage(made, { cookie: first.credential.cookie })).statusCode).toBe(401);
    expect((await builderImage(made, host)).statusCode).toBe(401);

    // Only ready pictures of this link, and only real picture ids.
    const unfinished = await insertImage('making', first.builderId);
    const failed = await insertImage('failed', first.builderId);
    const elsewhere = await insertImage('ready', second.builderId);
    for (const bad of [unfinished, failed, elsewhere, randomUUID(), 'not-an-id', 'ABCDEF01-0000-4000-8000-000000000000']) {
      const response = await builderImage(bad, first.credential);
      expect(response.statusCode, bad).toBe(404);
      expect(response.json()).toMatchObject({ message: NOT_FOUND });
    }
  });

  it('puts the portrait into the library card on submit, and the host can fetch it after the link is revoked', async () => {
    const { builderId, credential } = await builderLink();
    const other = await builderLink();
    const mine = (await builderPortrait(0, {}, credential)).json().imageId as string;
    const theirs = (await builderPortrait(0, {}, other.credential)).json().imageId as string;
    const draft = { ...blankDraft(), displayName: 'The hidden cartographer', appearance: 'A tall figure in a grey coat.' };
    const save = (revision: number, portraitId: string, operation: 'save' | 'submit' = 'save') =>
      call(`/api/character-builder/${operation}`, { commandId: randomUUID(), expectedRevision: revision, draft: { ...draft, portraitId } }, credential);

    // Another link's picture, and an id that is no picture, cannot be saved or submitted on this card.
    for (const foreign of [theirs, randomUUID(), await insertImage('making', builderId), mine.toUpperCase()]) {
      for (const operation of ['save', 'submit'] as const) {
        const refused = await save(0, foreign, operation);
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'conflict', message: FOREIGN });
      }
    }
    expect((await call('/api/character-builder', undefined, credential)).json()).toMatchObject({ revision: 0, submittedTemplate: null });

    const saved = await save(0, mine);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().draft.portraitId).toBe(mine);
    const submitted = await save(1, mine, 'submit');
    expect(submitted.statusCode, submitted.body).toBe(200);
    const template = submitted.json().submittedTemplate as { templateId: string; version: number };
    const library = (await call('/api/library')).json();
    expect(library.characters).toEqual([{ id: template.templateId, version: 1, definition: expect.objectContaining({ displayName: 'The hidden cartographer', portraitId: mine }) }]);

    const fetched = await libraryImage(mine);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['cache-control']).toBe(IMMUTABLE);
    expect(fetched.rawPayload.subarray(0, 8)).toEqual(PNG);
    // The picture is owned by the host, so it outlives the link.
    const revoked = await call(`/api/character-builders/${builderId}/revoke`, { commandId: randomUUID() });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await builderImage(mine, credential)).statusCode).toBe(401);
    expect((await libraryImage(mine)).statusCode).toBe(200);
    // The link cookie is not a host sign-in.
    expect((await libraryImage(mine, other.credential)).statusCode).toBe(401);
  });

  it('lets only the host make library portraits, and refuses blank details with the sentence for the subject', async () => {
    const seat = await playerSeat();
    const before = provider.requests.length;
    expect((await libraryPortrait(npcBody('npc-1'), { cookie: '' })).statusCode).toBe(401);
    for (const body of [npcBody('npc-1'), cardBody('card-1')]) {
      const refused = await libraryPortrait(body, seat);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'forbidden', message: HOST_ONLY });
    }
    // Strict bodies.
    for (const body of [
      { ...npcBody('npc-1'), extra: 'forged' }, { ...npcBody('npc-1'), subject: 'scene' }, { subject: 'npc', details: details() },
      { subject: 'npc', subjectKey: '', details: details() }, npcBody('npc-1', {}, { surprise: 'x' }),
    ]) expect((await libraryPortrait(body)).statusCode, JSON.stringify(body)).toBe(400);

    const blank = { appearance: '  ', role: ' ', pronouns: 'she/her', name: 'Ada Quill' };
    const npc = await libraryPortrait(npcBody('npc-1', {}, blank));
    expect(npc.statusCode, npc.body).toBe(400);
    expect(npc.json()).toMatchObject({ code: 'invalid_input', message: NEEDS_LOOK_OR_ROLE });
    const card = await libraryPortrait(cardBody('card-1', blank));
    expect(card.statusCode, card.body).toBe(400);
    expect(card.json()).toMatchObject({ code: 'invalid_input', message: NEEDS_LOOK });
    expect(provider.requests).toHaveLength(before);
    expect((await pool.query('SELECT 1 FROM images')).rowCount).toBe(0);
  });

  it('makes library portraits for non-player characters and cards with the right owner, key and style', async () => {
    const npc = await libraryPortrait(npcBody('npc-1', { pictureStyle: '  Charcoal sketch.  ' }, { name: 'Mara Voss', appearance: 'Mara Voss runs the bar.', role: 'Bartender' }));
    expect(npc.statusCode, npc.body).toBe(200);
    expect(Object.keys(npc.json())).toEqual(['imageId']);
    expect(await imageRow(npc.json().imageId)).toMatchObject({
      purpose: 'npc', status: 'ready', session_id: null, builder_id: null, attach: false, subject_id: 'npc-1',
      limit_key: `library:${hash(hostToken)}:npc-1`, owner_id: hash(hostToken), requested_by: hash(hostToken),
    });
    const npcPrompt = provider.requests.at(-1)!.prompt;
    expect(npcPrompt.startsWith('Charcoal sketch. ')).toBe(true);
    expect(npcPrompt).toContain('Bartender');
    expect(npcPrompt).not.toContain('Mara Voss');

    // A card portrait uses the default style, whatever style the body carries.
    const card = await libraryPortrait(cardBody('card-1', { name: 'Ada Quill', appearance: 'Ada Quill wears a grey coat.' }, { pictureStyle: 'Charcoal sketch' }));
    expect(card.statusCode, card.body).toBe(200);
    expect(await imageRow(card.json().imageId)).toMatchObject({
      purpose: 'card', status: 'ready', subject_id: 'card-1', limit_key: `library:${hash(hostToken)}:card-1`, owner_id: hash(hostToken),
    });
    const cardPrompt = provider.requests.at(-1)!.prompt;
    expect(cardPrompt).toContain(DEFAULT_PICTURE_STYLE);
    expect(cardPrompt).not.toContain('Charcoal');
    expect(cardPrompt).not.toContain('Ada Quill');

    // Role alone is enough for a non-player character.
    expect((await libraryPortrait(npcBody('npc-2', {}, { appearance: '', role: 'A ferry captain' }))).statusCode).toBe(200);

    // Pictures off: the same sentence as every other portrait route.
    const off = await boot(null);
    const refused = await libraryPortrait(npcBody('npc-3'), host, off);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'pictures_off', message: 'Pictures are off on this server.' });
  });

  it('serves a library picture only to the host who owns it', async () => {
    const made = (await libraryPortrait(cardBody('card-1'))).json().imageId as string;
    const served = await libraryImage(made);
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe(IMMUTABLE);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.subarray(0, 8)).toEqual(PNG);

    // A second host on the same database gets nothing, and gets their own picture fine.
    const otherToken = `library-portraits-other-${randomUUID()}`;
    const otherApp = await boot(new FakeImageProvider(), { hostToken: otherToken });
    const otherHost = await signIn(otherApp, otherToken);
    const hidden = await libraryImage(made, otherHost, otherApp);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ message: NOT_FOUND });
    const theirs = (await libraryPortrait(cardBody('card-1'), otherHost, otherApp)).json().imageId as string;
    expect((await libraryImage(theirs, otherHost, otherApp)).statusCode).toBe(200);
    expect((await libraryImage(theirs)).statusCode).toBe(404);

    const seat = await playerSeat();
    expect((await libraryImage(made, seat)).statusCode).toBe(403);
    expect((await libraryImage(made, { cookie: '' })).statusCode).toBe(401);
    // Pictures that are not ready, belong to a link rather than the library, or are not picture ids.
    const unfinished = await insertImage('making');
    const failed = await insertImage('failed');
    for (const bad of [unfinished, failed, randomUUID(), 'not-an-id', `${randomUUID()}x`]) {
      const response = await libraryImage(bad);
      expect(response.statusCode, bad).toBe(404);
      expect(response.json()).toMatchObject({ message: NOT_FOUND });
    }
  });

  it('carries a scenario\'s NPC portrait and picture style into the show made from it', async () => {
    const portrait = (await libraryPortrait(npcBody('npc-1', { pictureStyle: 'Ink wash' }, { role: 'Bartender' }))).json().imageId as string;
    const scenario: ScenarioDefinition = {
      ...starter.scenario, pictureStyle: 'Ink wash',
      npcs: starter.scenario.npcs.map((npc, index) => index === 0 ? { ...npc, portraitId: portrait } : npc),
    };
    const saved = await call('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: scenario });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().definition).toMatchObject({ pictureStyle: 'Ink wash' });
    expect((await call('/api/library')).json().picturesEnabled).toBe(true);

    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await call('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    const created = await call('/api/sessions', { commandId: randomUUID(), scenario: { templateId: saved.json().id, version: saved.json().version }, characters });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().sessionId as string;

    const view = async () => (await call(`/api/sessions/${sessionId}`)).json() as DirectorSnapshot;
    // Creation starts an automatic portrait, in the show's style, for every other non-player character with an appearance or role.
    const needPortraits = (await view()).npcDetails.slice(1).filter(npc => npc.appearance.trim() || npc.role.trim());
    expect(needPortraits.length).toBeGreaterThan(0);
    const creationPortraits = async () => (await pool.query(
      "SELECT id, subject_id, status, prompt FROM images WHERE session_id=$1 AND purpose='npc' ORDER BY created_at, id", [sessionId])).rows as Array<{ id: string; subject_id: string; status: string; prompt: string }>;
    await waitFor(async () => {
      const made = await creationPortraits();
      return made.length === needPortraits.length && made.every(row => row.status === 'ready');
    }, 'the creation portraits to finish');
    const made = await creationPortraits();
    expect(made.map(row => row.subject_id).sort()).toEqual(needPortraits.map(npc => npc.id).sort());
    for (const row of made) expect(row.prompt.startsWith('Ink wash. '), row.prompt).toBe(true);
    await waitFor(async () => (await view()).npcDetails.slice(1).every(npc => !needPortraits.some(need => need.id === npc.id) || npc.portraitId), 'the creation portraits to attach');
    const npcs = (await view()).npcDetails;
    expect(npcs[0]!.portraitId).toBe(portrait);
    for (const npc of npcs.slice(1)) {
      const automatic = made.find(row => row.subject_id === npc.id);
      if (automatic) expect(npc.portraitId, npc.id).toBe(automatic.id);
      else expect(npc.portraitId, npc.id).toBeUndefined();
    }
    expect((await pool.query('SELECT brief FROM sessions WHERE id=$1', [sessionId])).rows[0].brief).toMatchObject({ pictureStyle: 'Ink wash' });

    // The scene picture for the opening scene is drawn in the show's style.
    // Seats from saved cards start approved, so the show can start straight away.
    const seats = (await view()).characterDetails;
    expect(seats.length).toBeGreaterThan(0);
    for (const character of seats) {
      expect(character.approved, character.id).toBe(true);
      expect(character.draft, character.id).toBeNull();
    }
    const started = await call(`/api/sessions/${sessionId}/commands`, {
      commandId: randomUUID(), type: 'start_session', expectedStateRevision: (await view()).session.stateRevision, overrideUnreadyReason: 'Testing a started show.',
    });
    expect(started.statusCode, started.body).toBe(200);
    const sceneRow = async () => (await pool.query("SELECT id FROM images WHERE session_id=$1 AND purpose='scene'", [sessionId])).rows[0] as { id: string } | undefined;
    await waitFor(async () => {
      const scene = await sceneRow();
      return Boolean(scene && provider.requests.some(request => request.requestId === scene.id));
    }, 'the scene picture request');
    const sceneId = (await sceneRow())!.id;
    expect(provider.requests.find(request => request.requestId === sceneId)!.prompt.startsWith('Ink wash. ')).toBe(true);
    await waitFor(async () => (await pool.query("SELECT 1 FROM images WHERE session_id=$1 AND purpose='scene' AND status='ready'", [sessionId])).rowCount === 1, 'the scene picture to finish');
    // The portrait from the library is still readable through the show by the director.
    expect((await call(`/api/sessions/${sessionId}/images/${portrait}`)).statusCode).toBe(200);
  });

  it('refuses the third library portrait in an hour when the hourly limit is 2', async () => {
    const limited = new FakeImageProvider();
    const small = await boot(limited, { imageHourlyLimit: 2 });
    const signedIn = await signIn(small, hostToken);
    for (const key of ['npc-1', 'card-1']) {
      expect((await libraryPortrait(key.startsWith('npc') ? npcBody(key) : cardBody(key), signedIn, small)).statusCode).toBe(200);
    }
    const third = await libraryPortrait(npcBody('npc-2'), signedIn, small);
    expect(third.statusCode, third.body).toBe(429);
    expect(third.json().code).toBe('picture_limit');
    expect(third.json().message).toContain('Try again in');
    expect(third.json().message).toMatch(HOURLY);
    expect(limited.requests).toHaveLength(2);
    expect((await pool.query("SELECT 1 FROM images WHERE status IN ('making','ready')")).rowCount).toBe(2);
    // Builder links share the same hourly count.
    const { credential } = await builderLink(signedIn, small);
    const blocked = await builderPortrait(0, {}, credential, small);
    expect(blocked.statusCode, blocked.body).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'picture_limit' });
    expect(limited.requests).toHaveLength(2);
  });

  it('makes an 11th portrait for the same character within the hour', async () => {
    for (let index = 0; index < 11; index++) {
      const made = await libraryPortrait(cardBody('card-1', { appearance: `A tall figure number ${index}.` }));
      expect(made.statusCode, `${index}: ${made.body}`).toBe(200);
    }
    expect(provider.requests).toHaveLength(11);
  });
});
