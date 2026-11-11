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
    const directory = join(process.cwd(), process.env.TEST_ASSET_DIR ?? 'test-results/audio');
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

const openOptions = (tab: Page) => tab.getByTestId('audio-options').evaluate(el => { (el as HTMLDetailsElement).open = true; });
const setShowAll = (tab: Page, open: boolean) => tab.getByTestId('stage-show-all').evaluate((el, value) => { (el as HTMLDetailsElement).open = value; }, open);

const mediaState = (page: Page) => page.evaluate(() => (window as any).__audio.map((audio: any) => ({ src: audio.src, paused: audio.paused })) as Array<{ src: string; paused: boolean }>);

test('the narration line shows and controls the show audio with the Show all fold closed', async ({ page, context }) => {
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
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const path = `/sessions/${sessionId}`;
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
  await seedAudio(sessionId, firstBeat);
  const stage = await context.newPage();
  await stage.goto(`${path}/stage`);
  await page.reload();
  await expect(page.getByTestId('director-controls')).toBeVisible();

  const line = page.getByTestId('narration-line');
  const words = page.getByTestId('narration-line-text');
  const playbackStatus = async () => (await api(page, `${path}/playback`)).status as string;
  await expect(line).toBeVisible();

  // No page holds the show audio yet.
  await expect(words).toContainText('No page is playing the show audio.');
  await expect(page.getByTestId('narration-pause')).toHaveCount(0);

  await openOptions(stage);
  await stage.getByTestId('present-audio').click();
  await stage.getByTestId('confirm-present-audio').click();
  await expect(stage.getByTestId('release-audio')).toBeVisible();

  // The full panel starts the narration; after that everything is done from the line with the fold closed.
  await setShowAll(page, true);
  await page.getByTestId('start-audio').click();
  await setShowAll(page, false);
  await expect(page.getByTestId('stage-show-all')).not.toHaveJSProperty('open', true);
  await expect.poll(playbackStatus).toBe('playing');
  await expect(words).toHaveText('Narration playing: beat 1.');
  await expect(page.getByTestId('narration-pause')).toBeVisible();
  await expect(page.getByTestId('narration-stop')).toBeVisible();
  await expect.poll(async () => (await mediaState(stage)).filter(item => !item.paused).length).toBe(1);

  await page.getByTestId('narration-pause').click();
  await expect.poll(playbackStatus).toBe('paused');
  await expect(words).toHaveText('Narration paused: beat 1.');
  await expect.poll(async () => (await mediaState(stage)).every(item => item.paused)).toBe(true);
  await expect(page.getByTestId('narration-pause')).toHaveCount(0);

  await page.getByTestId('narration-resume').click();
  await expect.poll(playbackStatus).toBe('playing');
  await expect(words).toHaveText('Narration playing: beat 1.');
  await expect.poll(async () => (await mediaState(stage)).some(item => !item.paused)).toBe(true);

  // Pause, then lose the page that holds the audio: the line says so and Resume cannot be pressed.
  await page.getByTestId('narration-pause').click();
  await expect.poll(playbackStatus).toBe('paused');
  await stage.getByTestId('release-audio').click();
  await expect(words).toHaveText('No page is playing the show audio. Narration paused: beat 1.');
  await expect(page.getByTestId('narration-resume')).toBeDisabled();
  await stage.getByTestId('present-audio').click();
  await stage.getByTestId('confirm-present-audio').click();
  await expect(stage.getByTestId('release-audio')).toBeVisible();
  await expect(words).toHaveText('Narration paused: beat 1.');
  await expect(page.getByTestId('narration-resume')).toBeEnabled();
  await page.getByTestId('narration-resume').click();
  await expect.poll(playbackStatus).toBe('playing');

  await page.getByTestId('narration-stop').click();
  await expect.poll(playbackStatus).toBe('stopped');
  await expect(words).toHaveText('Narration stopped: beat 1.');
  await expect(page.getByTestId('narration-pause')).toHaveCount(0);
  await expect(page.getByTestId('narration-stop')).toHaveCount(0);
  await expect.poll(async () => (await mediaState(stage)).every(item => item.paused)).toBe(true);

  // The line wraps on a narrow screen without a sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
