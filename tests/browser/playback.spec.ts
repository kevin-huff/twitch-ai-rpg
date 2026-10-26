import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import type { PublishedBeat } from '@rpg/contracts';

async function api(page: Page, path: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

// Exercise real coordination and identities without a paid speech request or audio device.
async function seedAudio(sessionId: string, beatId: string) {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://rpg@127.0.0.1:55432/rpg_test' });
  try {
    const bytes = await readFile(new URL('../fixtures/silence.mp3', import.meta.url));
    const directory = join(process.cwd(), 'test-results/audio');
    await mkdir(directory, { recursive: true });
    const publication: PublishedBeat = (await pool.query('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [sessionId, beatId])).rows[0].data;
    const segments = [];
    for (const segment of publication.segments.filter(segment => ['narration', 'npc_dialogue'].includes(segment.kind))) {
      const asset = createHash('sha256').update(`${sessionId}:${segment.id}`).digest('hex');
      await writeFile(join(directory, `${asset}.mp3`), bytes);
      await pool.query('INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,$3,$4)', [asset, sessionId, 'audio/mpeg', bytes.byteLength]);
      segments.push({ id: segment.id, text: segment.text, speaker: segment.speaker?.displayName ?? 'Narrator', voiceProfileId: segment.voiceProfileId ?? 'voice_narrator', url: `/api/sessions/${sessionId}/audio/assets/${asset}` });
    }
    await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest) VALUES($1,$2,'browser-playback','ready',$3,now(),$4)", [sessionId, beatId, randomUUID(), { beatId, segments }]);
    return segments;
  } finally { await pool.end(); }
}

const mediaState = (page: Page) => page.evaluate(() => (window as any).__audio.map((audio: any) => ({ src: audio.src, paused: audio.paused, time: audio.currentTime, volume: audio.volume })) as Array<{ src: string; paused: boolean; time: number; volume: number }>);

test('one stage presents shared narration while listeners join, refresh, and follow director controls', async ({ page, context, browser }) => {
  await context.addInitScript(() => {
    (window as any).__audio = [];
    class TestAudio {
      src: string; paused = true; volume = 1; muted = false; duration = 120; readyState = 4;
      onended: null | (() => void) = null; onerror: null | (() => void) = null; onloadedmetadata: null | (() => void) = null;
      private position = 0; private startedAt = 0;
      constructor(src = '') { this.src = src; (window as any).__audio.push(this); }
      get currentTime() { return this.position + (this.paused ? 0 : (performance.now() - this.startedAt) / 1000); }
      set currentTime(value: number) { this.position = value; this.startedAt = performance.now(); }
      play() { if (this.paused) { this.startedAt = performance.now(); this.paused = false; } return Promise.resolve(); }
      pause() { this.position = this.currentTime; this.paused = true; }
      load() {}
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }
      addEventListener() {}
      removeEventListener() {}
    }
    (window as any).Audio = TestAudio;
  });
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const path = `/sessions/${sessionId}`;
  const identity = new URL(page.url()).searchParams.get('identity');
  let state = await api(page, path);
  const grant = await api(page, `${path}/test-seat`, { characterId: state.characters[0].id });
  const player = await context.newPage();
  await player.goto(`${path}/play?identity=${grant.identityId}`);
  async function command(command: Record<string, unknown>) {
    state = (await api(page, `${path}/commands`, { commandId: randomUUID(), ...command })).snapshot;
  }
  async function publish(text: string) {
    await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
    const submitted = (await api(player, `${path}/commands`, { type: 'save_submission', commandId: randomUUID(), expectedSubmissionRevision: 0, contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, kind: 'say', text, recipientNpcIds: [state.npcs[0].id] })).snapshot;
    await beat({ type: 'plan_beat', submissionIds: [submitted.submissions.find((input: { text: string }) => input.text === text).id] });
    await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
    await beat({ type: 'lock_beat' });
    await beat({ type: 'render_beat' });
    await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
    return state.history.at(-1).id as string;
  }
  const firstBeat = await publish('What happened to the missing owner?');
  const segments = await seedAudio(sessionId, firstBeat);
  expect(segments.length).toBeGreaterThan(1);
  const canonicalBefore = await api(page, path);
  const stage = await context.newPage();
  const otherStage = await context.newPage();
  await Promise.all([stage, otherStage].map(tab => tab.goto(`${path}/stage?identity=${identity}`)));
  await page.reload();
  await stage.getByTestId('present-audio').click();
  await stage.getByTestId('confirm-present-audio').click();
  await expect(stage.getByTestId('release-audio')).toBeVisible();
  await expect(otherStage.getByTestId('present-audio')).toBeDisabled();
  await page.getByTestId('start-audio').click();
  await expect.poll(async () => (await mediaState(stage)).filter(item => !item.paused).length).toBe(1);
  expect(await mediaState(otherStage)).toHaveLength(0);
  expect(await mediaState(player)).toHaveLength(0);
  expect(await mediaState(page)).toHaveLength(0);

  await expect.poll(async () => (await api(page, `${path}/playback`)).positionMs).toBeGreaterThan(1200);
  await player.getByTestId('listen-audio').click();
  await expect.poll(async () => (await mediaState(player)).at(-1)?.time ?? 0).toBeGreaterThan(1);
  await player.getByTestId('audio-volume').evaluate(input => {
    (input as HTMLInputElement).value = '0.3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await mediaState(player)).at(-1)?.volume).toBe(0.3);
  await player.reload();
  await expect(player.getByTestId('listen-audio')).toBeVisible();
  expect(await mediaState(player)).toHaveLength(0);
  await player.getByTestId('listen-audio').click();
  await expect.poll(async () => (await mediaState(player)).at(-1)?.time ?? 0).toBeGreaterThan(1);

  await page.getByTestId('pause-audio').click();
  await expect.poll(async () => (await api(page, `${path}/playback`)).status).toBe('paused');
  await expect.poll(async () => (await mediaState(stage)).every(item => item.paused)).toBe(true);
  await expect.poll(async () => (await mediaState(player)).every(item => item.paused)).toBe(true);
  await page.getByTestId('resume-audio').click();
  await expect.poll(async () => (await mediaState(stage)).some(item => !item.paused)).toBe(true);
  await page.getByTestId('skip-audio').click();
  await expect.poll(async () => (await api(page, `${path}/playback`)).segmentIndex).toBe(1);
  await expect.poll(async () => (await mediaState(stage)).find(item => !item.paused)?.src ?? '').toContain(segments[1].url);
  await page.getByTestId('stop-audio').click();
  await expect.poll(async () => (await api(page, `${path}/playback`)).status).toBe('stopped');
  const canonicalAfter = await api(page, path);
  for (const field of ['session', 'history', 'tracks', 'facts', 'characters', 'npcDetails', 'submissions']) expect(canonicalAfter[field]).toEqual(canonicalBefore[field]);

  await page.getByTestId('replay-audio').click();
  const playbackId = (await api(page, `${path}/playback`)).playbackId;
  await publish('Someone has offered to sell the ledger.');
  await expect.poll(async () => (await api(page, path)).history.length).toBe(2);
  expect(await api(page, `${path}/playback`)).toMatchObject({ playbackId, manifest: { beatId: firstBeat }, status: 'playing' });
  await expect.poll(async () => (await mediaState(stage)).find(item => !item.paused)?.src ?? '').toContain(segments[0].url);
  await page.setViewportSize({ width: 430, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.audio-panel').screenshot({ path: 'test-results/playback-director.png' });
  await stage.locator('.audio-panel').screenshot({ path: 'test-results/playback-stage.png' });
  await player.locator('.audio-panel').screenshot({ path: 'test-results/playback-player.png' });
  await stage.getByTestId('release-audio').click();
  await expect.poll(async () => (await api(page, `${path}/playback`)).status).toBe('paused');
  await expect.poll(async () => (await mediaState(stage)).every(item => item.paused)).toBe(true);
  await otherStage.getByTestId('present-audio').click();
  await otherStage.getByTestId('confirm-present-audio').click();
  await expect(otherStage.getByTestId('release-audio')).toBeVisible();
  expect((await api(page, `${path}/playback`)).status).toBe('paused');
  expect((await mediaState(otherStage)).every(item => item.paused)).toBe(true);
  await otherStage.getByTestId('release-audio').click();

  // A separate context uses the real browser decoder and native ended events.
  const nativeContext = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await context.storageState() });
  try {
    await nativeContext.addInitScript(() => {
      (window as any).__audio = [];
      const NativeAudio = window.Audio;
      (window as any).Audio = function (src: string) {
        const audio = new NativeAudio(src);
        (window as any).__audio.push(audio);
        return audio;
      };
    });
    const nativeStage = await nativeContext.newPage();
    await nativeStage.goto(`${path}/stage?identity=${identity}`);
    await nativeStage.getByTestId('present-audio').click();
    await nativeStage.getByTestId('confirm-present-audio').click();
    await expect(nativeStage.getByTestId('release-audio')).toBeVisible();
    await page.getByTestId('replay-audio').click();
    await expect.poll(async () => (await mediaState(nativeStage)).find(item => !item.paused)?.time ?? 0).toBeGreaterThan(0.05);
    const replayed = await api(page, `${path}/playback`);
    expect(replayed.manifest.beatId).toBe(firstBeat);
    expect(replayed.playbackId).not.toBe(playbackId);
    await expect.poll(async () => (await api(page, `${path}/playback`)).status).toBe('complete');
    expect((await mediaState(nativeStage)).length).toBe(segments.length);
    await expect(nativeStage.locator('.audio-panel [role=alert]')).toHaveCount(0);
  } finally { await nativeContext.close(); }
});
