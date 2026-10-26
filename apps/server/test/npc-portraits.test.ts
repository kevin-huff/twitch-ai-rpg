import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorSnapshot } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { PICTURE_MESSAGES } from '../src/images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const NPC_ONLY = 'Only the director can change portraits of non-player characters.';
const NPC_MISSING = 'That character is not in this session.';
const NOTHING_TO_DRAW = 'Give this character an appearance or a role first.';
const NPC_MAKING = 'A portrait for this character is already being made. Wait for it to finish.';
const OFF = 'Pictures are off on this server.';
const LOOKS = 'A tall ferryman with a salt-white beard and a patched oilskin coat.';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; stage: string; player: string }
interface NpcRow { id: string; status: string; attach: boolean; message: string | null }

suite('non-player character portraits through commands and routes', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  // The fake provider waits on `gate` and fails while `failing` is set, so a test decides when a portrait finishes.
  const control: { gate: Promise<void> | null; failing: boolean } = { gate: null, failing: false };
  let release: () => void = () => undefined;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  const hold = () => {
    control.gate = new Promise<void>(resolve => { release = () => { control.gate = null; resolve(); }; });
  };
  async function boot(options: { images?: boolean } = {}) {
    control.gate = null;
    control.failing = false;
    const hostToken = `npc-portraits-test-host-${randomUUID()}`;
    const images = options.images === false ? null : new FakeImageProvider({
      hold: () => control.gate ?? Promise.resolve(),
      fail: () => control.failing ? new ProviderError('http_error', 'Sogni') : null,
    });
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(images ? { images } : {}) });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    return images;
  }

  // A rehearsal show set live straight in the database, so no opening scene picture is reserved.
  async function liveShow(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const cookies: Record<string, string> = {};
    for (const invite of created.json().invites as Array<{ role: string; token: string }>) {
      if (invite.role !== 'stage' && (invite.role !== 'player' || cookies.player)) continue;
      const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      cookies[invite.role] = cookie(redeemed);
    }
    const sessionId = created.json().sessionId as string;
    await pool.query("UPDATE sessions SET status='live' WHERE id=$1", [sessionId]);
    return { sessionId, stage: cookies.stage!, player: cookies.player! };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const rows = async (show: Show) => (await pool.query(
    "SELECT id, status, attach, message FROM images WHERE session_id=$1 AND purpose='npc' ORDER BY created_at, id", [show.sessionId])).rows as NpcRow[];
  const rowsFor = async (show: Show, npcId: string) => (await pool.query(
    "SELECT id, status, attach, message FROM images WHERE session_id=$1 AND purpose='npc' AND subject_id=$2 ORDER BY created_at, id", [show.sessionId, npcId])).rows as NpcRow[];
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const waitForStatus = (show: Show, id: string, status: string) =>
    waitFor(async () => (await rows(show)).find(row => row.id === id)?.status === status, `portrait ${status}`);
  const portraitOf = async (show: Show, npcId: string) => (await director(show)).npcDetails.find(npc => npc.id === npcId)?.portraitId;

  const command = (show: Show, payload: Record<string, unknown>) => request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload });
  async function saveNpc(show: Show, changes: Record<string, unknown>, existing?: { id: string; version: number }) {
    const view = await director(show);
    const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, portraitId: _portraitId, ...profile } = view.npcDetails[0]!;
    const response = await command(show, {
      type: 'save_npc', expectedStateRevision: view.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true,
      ...(existing ? { npcId: existing.id, expectedNpcVersion: existing.version } : { expectedNpcVersion: 0 }),
      profile: { ...profile, displayName: 'The ferryman', role: 'Ferry pilot', appearance: LOOKS, ...changes },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().snapshot as DirectorSnapshot;
  }
  // Adds a character mid-show and returns its id.
  async function addNpc(show: Show, changes: Record<string, unknown> = {}) {
    const before = new Set((await director(show)).npcDetails.map(npc => npc.id));
    const after = await saveNpc(show, changes);
    return after.npcDetails.find(npc => !before.has(npc.id))!.id;
  }
  const portraitPost = (show: Show, npcId: string, path = '', credential = host, payload: Record<string, unknown> = {}) =>
    request(`/api/sessions/${show.sessionId}/npcs/${npcId}/portrait${path}`, payload, credential);
  // A new character with its automatic portrait finished and attached.
  async function npcWithPortrait(show: Show) {
    const npcId = await addNpc(show);
    await waitFor(async () => (await rowsFor(show, npcId))[0]?.status === 'ready', 'the first portrait');
    const [row] = await rowsFor(show, npcId);
    return { npcId, first: row!.id };
  }

  it('gives a character added during the show a portrait without anyone pressing a button', async () => {
    const images = await boot();
    const show = await liveShow();
    hold();
    const before = await director(show);
    const added = await saveNpc(show, {});
    const npcId = added.npcDetails.find(npc => !before.npcDetails.some(old => old.id === npc.id))!.id;
    // The command answers at once; the portrait is still being made.
    expect(added.portraitJobs).toEqual([{ npcId, state: 'making', message: null }]);
    expect(added.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBeUndefined();
    const [row, ...others] = await rows(show);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ status: 'making', attach: true });

    release();
    await waitForStatus(show, row!.id, 'ready');
    const after = await director(show);
    expect(after.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBe(row!.id);
    expect(after.npcs.find(npc => npc.id === npcId)!.portraitId).toBe(row!.id);
    expect(after.portraitJobs).toEqual([]);
    // The picture shows only the look, never the name.
    expect(images!.requests).toHaveLength(1);
    expect(images!.requests[0]!.prompt).toContain(LOOKS);
    expect(images!.requests[0]!.prompt).not.toContain('The ferryman');
    // Everyone in the show can fetch a portrait that is attached to a character.
    const stageFetch = await request(`/api/sessions/${show.sessionId}/images/${row!.id}`, undefined, show.stage);
    expect(stageFetch.statusCode).toBe(200);
    const events = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind IN ('portrait.ready')", [show.sessionId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data).toMatchObject({ imageId: row!.id, purpose: 'npc', subjectId: npcId });
  });

  it('draws from the role alone and reserves nothing when there is neither an appearance nor a role', async () => {
    await boot();
    const show = await liveShow();
    const roleOnly = await addNpc(show, { appearance: '', role: 'Lighthouse keeper' });
    await waitFor(async () => (await rowsFor(show, roleOnly))[0]?.status === 'ready', 'a portrait from the role');

    const blank = await addNpc(show, { appearance: '  ', role: '' });
    expect(await rowsFor(show, blank)).toEqual([]);
    expect((await director(show)).portraitJobs).toEqual([]);
    expect(await portraitOf(show, blank)).toBeUndefined();
    expect(await rows(show)).toHaveLength(1);
  });

  it('keeps the attached portrait when a later edit carries an old or missing one, and the portrait itself changes no version', async () => {
    await boot();
    const show = await liveShow();
    hold();
    const npcId = await addNpc(show);
    const [pending] = await rows(show);
    const making = await director(show);
    release();
    await waitForStatus(show, pending!.id, 'ready');
    const done = await director(show);
    // The finished portrait left the revision and the character's version alone.
    expect(done.session.stateRevision).toBe(making.session.stateRevision);
    expect(done.npcDetails.find(npc => npc.id === npcId)!.version).toBe(making.npcDetails.find(npc => npc.id === npcId)!.version);
    expect(done.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBe(pending!.id);

    // A form opened before the portrait existed sends no portrait at all.
    let current = done.npcDetails.find(npc => npc.id === npcId)!;
    const missing = await saveNpc(show, { mood: 'tired' }, { id: npcId, version: current.version });
    current = missing.npcDetails.find(npc => npc.id === npcId)!;
    expect(current).toMatchObject({ mood: 'tired', portraitId: pending!.id, version: done.npcDetails.find(npc => npc.id === npcId)!.version + 1 });

    // A form that still carries an older portrait cannot put it back.
    const stale = await saveNpc(show, { mood: 'calm', portraitId: 'an-older-portrait' }, { id: npcId, version: current.version });
    expect(stale.npcDetails.find(npc => npc.id === npcId)).toMatchObject({ mood: 'calm', portraitId: pending!.id });
    // An edit never makes a new picture.
    expect(await rows(show)).toHaveLength(1);
  });

  describe('Create portrait', () => {
    it('answers 202, shows the portrait being made, then attaches it', async () => {
      await boot();
      const show = await liveShow();
      const before = await director(show);
      const npc = before.npcDetails[0]!;
      expect(npc.appearance.trim() || npc.role.trim()).not.toBe('');
      expect(npc.portraitId).toBeUndefined();
      hold();
      const pressed = await portraitPost(show, npc.id);
      expect(pressed.statusCode, pressed.body).toBe(202);
      const { imageId } = pressed.json() as { imageId: string };

      const making = await director(show);
      expect(making.portraitJobs).toEqual([{ npcId: npc.id, state: 'making', message: null }]);
      expect(making.npcDetails[0]!.portraitId).toBeUndefined();
      const event = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='portrait.making'", [show.sessionId]);
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0].data).toEqual({ imageId, purpose: 'npc', subjectId: npc.id });

      // A second press while it is being made is turned away, and nothing new is reserved.
      const again = await portraitPost(show, npc.id);
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json()).toMatchObject({ code: 'picture_making', message: NPC_MAKING });
      expect(await rows(show)).toHaveLength(1);

      release();
      await waitForStatus(show, imageId, 'ready');
      const after = await director(show);
      expect(after.npcDetails[0]!.portraitId).toBe(imageId);
      expect(after.portraitJobs).toEqual([]);
      // Neither the revision nor the character's version moved because of the portrait.
      expect(after.session.stateRevision).toBe(before.session.stateRevision);
      expect(after.npcDetails[0]!.version).toBe(npc.version);

      // The button works again once the picture is done, and the new portrait replaces the old one.
      const second = await portraitPost(show, npc.id);
      expect(second.statusCode, second.body).toBe(202);
      await waitForStatus(show, second.json().imageId, 'ready');
      expect(await portraitOf(show, npc.id)).toBe(second.json().imageId);
    });

    it('turns away empty characters, unknown characters, ended shows and anyone who is not the director', async () => {
      await boot();
      const show = await liveShow();
      const blank = await addNpc(show, { appearance: '', role: '' });
      const refused = await portraitPost(show, blank);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'invalid_input', message: NOTHING_TO_DRAW });

      const unknown = await portraitPost(show, 'nobody-here');
      expect(unknown.statusCode, unknown.body).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'not_found', message: NPC_MISSING });

      const npcId = (await director(show)).npcDetails[0]!.id;
      for (const credential of [show.player, show.stage]) {
        for (const path of ['', '/remove']) {
          const forbidden = await portraitPost(show, npcId, path, credential);
          expect(forbidden.statusCode, forbidden.body).toBe(403);
          expect(forbidden.json()).toMatchObject({ code: 'forbidden', message: NPC_ONLY });
        }
      }
      expect((await portraitPost(show, npcId, '', '')).statusCode).toBe(401);
      expect((await portraitPost(show, npcId, '', host, { extra: true })).statusCode).toBe(400);

      // Another host's show looks like it does not exist.
      const foreign = await liveShow();
      await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [foreign.sessionId, 'foreign-host']);
      expect((await portraitPost(foreign, npcId)).statusCode).toBe(404);
      expect((await portraitPost(foreign, npcId, '/remove')).statusCode).toBe(404);

      await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [show.sessionId]);
      const ended = await portraitPost(show, npcId);
      expect(ended.statusCode, ended.body).toBe(409);
      expect(ended.json()).toMatchObject({ code: 'conflict', message: 'This session has ended.' });
      // Nothing was reserved by any of these.
      expect(await rowsFor(show, npcId)).toEqual([]);
      expect(await rowsFor(show, blank)).toEqual([]);
    });

    it('shows a failed portrait with the live character sentence and keeps the old portrait', async () => {
      await boot();
      const show = await liveShow();
      const { npcId, first } = await npcWithPortrait(show);
      control.failing = true;
      const pressed = await portraitPost(show, npcId);
      expect(pressed.statusCode, pressed.body).toBe(202);
      await waitForStatus(show, pressed.json().imageId, 'failed');

      const view = await director(show);
      expect(view.portraitJobs).toEqual([{ npcId, state: 'failed', message: PICTURE_MESSAGES.npcFailed }]);
      expect(PICTURE_MESSAGES.npcFailed).toBe('The portrait could not be made. Press Create portrait to try again.');
      expect(view.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBe(first);
      const failure = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='portrait.failed'", [show.sessionId]);
      expect(failure.rows).toHaveLength(1);

      // Pressing again after the fault clears works, and the failure message goes away.
      control.failing = false;
      const retry = await portraitPost(show, npcId);
      expect(retry.statusCode, retry.body).toBe(202);
      await waitForStatus(show, retry.json().imageId, 'ready');
      const fixed = await director(show);
      expect(fixed.portraitJobs).toEqual([]);
      expect(fixed.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBe(retry.json().imageId);
    });
  });

  describe('Remove portrait', () => {
    it('clears the portrait', async () => {
      await boot();
      const show = await liveShow();
      const { npcId, first } = await npcWithPortrait(show);
      const before = await director(show);
      expect(before.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBe(first);

      const removed = await portraitPost(show, npcId, '/remove');
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toEqual({ ok: true });
      const after = await director(show);
      expect(after.npcDetails.find(npc => npc.id === npcId)!.portraitId).toBeUndefined();
      expect(after.npcs.find(npc => npc.id === npcId)!.portraitId).toBeUndefined();
      expect(after.session.stateRevision).toBe(before.session.stateRevision);
      expect(after.npcDetails.find(npc => npc.id === npcId)!.version).toBe(before.npcDetails.find(npc => npc.id === npcId)!.version);
      const event = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='portrait.removed'", [show.sessionId]);
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0].data).toMatchObject({ imageId: first, subjectId: npcId });

      // The audience can no longer fetch it, because nothing refers to it any more.
      expect((await request(`/api/sessions/${show.sessionId}/images/${first}`, undefined, show.stage)).statusCode).toBe(404);
      expect((await portraitPost(show, 'nobody-here', '/remove')).statusCode).toBe(404);
    });

    it('stops a portrait that was still being made from attaching afterwards', async () => {
      await boot();
      const show = await liveShow();
      const npcId = (await director(show)).npcDetails[0]!.id;
      hold();
      const pressed = await portraitPost(show, npcId);
      expect(pressed.statusCode, pressed.body).toBe(202);
      const { imageId } = pressed.json() as { imageId: string };
      // Give the job time to reach the held provider call.
      await waitFor(async () => Boolean((await pool.query('SELECT 1 FROM images WHERE id=$1 AND started_at IS NOT NULL', [imageId])).rowCount), 'the job to start');

      const removed = await portraitPost(show, npcId, '/remove');
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await pool.query('SELECT attach FROM images WHERE id=$1', [imageId])).rows[0].attach).toBe(false);
      // With attach off, the director no longer sees a job for this character.
      expect((await director(show)).portraitJobs).toEqual([]);

      release();
      await waitForStatus(show, imageId, 'ready');
      expect(await portraitOf(show, npcId)).toBeUndefined();
      const ended = await pool.query("SELECT 1 FROM audit_events WHERE session_id=$1 AND kind='portrait.ready'", [show.sessionId]);
      expect(ended.rowCount).toBe(0);
    });

    it('keeps an older portrait removed when a job that was making finishes later', async () => {
      await boot();
      const show = await liveShow();
      const { npcId } = await npcWithPortrait(show);
      hold();
      const pressed = await portraitPost(show, npcId);
      expect(pressed.statusCode, pressed.body).toBe(202);
      expect((await portraitPost(show, npcId, '/remove')).statusCode).toBe(200);
      expect(await portraitOf(show, npcId)).toBeUndefined();
      release();
      await waitForStatus(show, pressed.json().imageId, 'ready');
      expect(await portraitOf(show, npcId)).toBeUndefined();
      // Pressing Create portrait again starts fresh and attaches.
      const next = await portraitPost(show, npcId);
      expect(next.statusCode, next.body).toBe(202);
      await waitForStatus(show, next.json().imageId, 'ready');
      expect(await portraitOf(show, npcId)).toBe(next.json().imageId);
    });
  });

  it('answers both character routes with the pictures-off sentence and makes no portrait when there is no image provider', async () => {
    await boot({ images: false });
    const show = await liveShow();
    const npcId = (await director(show)).npcDetails[0]!.id;
    for (const path of ['', '/remove']) {
      const refused = await portraitPost(show, npcId, path);
      expect(refused.statusCode, `${path} ${refused.body}`).toBe(503);
      expect(refused.json()).toMatchObject({ code: 'pictures_off', message: OFF });
    }
    // A character added during the show still saves, with no portrait and no portrait job.
    const added = await saveNpc(show, {});
    expect(added.picturesEnabled).toBe(false);
    expect(added.portraitJobs).toEqual([]);
    expect(await rows(show)).toEqual([]);
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-npc-portraits-'));
  });
  afterEach(async () => {
    release();
    await app?.close();
    app = null;
  });
  afterAll(async () => {
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });
});
