import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

test.setTimeout(150000);

const MIN_CHUNK_MS = 4000;
const WORDS_PER_SECOND = 2.5;

type Script = { narration: string; reply: string };

// Signs in as host, has two test seats each send one Say line, plans, locks and drafts the beat, replaces the script
// with one narration segment and one non-player line, and opens the main show link as the overlay in a 1920x1080
// browser that looks like OBS (Open Broadcaster Software) and presents the broadcast audio.
async function setUpShow(page: Page, browser: Browser, lines: string[], script: Script) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;

  let state = (await api(page, path)).body;
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    expect(result.status, JSON.stringify(result.body).slice(0, 300)).toBe(200);
    if (!identity) state = result.body.snapshot;
    return result.body.snapshot;
  };

  const seats: string[] = [];
  for (const character of state.characters.slice(0, 2)) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).body.identityId);
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const npc = state.npcs.find((item: any) => item.status === 'present');
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const snap = await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: lines[index], recipientNpcIds: [npc.id] }, seats[index]);
    ids.push(snap.submissions.find((item: any) => item.text === lines[index]).id);
  }

  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  await beat({ type: 'plan_beat', submissionIds: ids });
  await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  await beat({ type: 'edit_script', segments: [
    { kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: script.narration },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: script.reply },
  ] });

  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  const obsContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await obsContext.addInitScript(() => {
    (window as unknown as { obsstudio: object }).obsstudio = {};
    class TestAudio {
      src: string; paused = true; volume = 1; muted = false; duration = 120; readyState = 4;
      onended: null | (() => void) = null; onerror: null | (() => void) = null; onloadedmetadata: null | (() => void) = null;
      private position = 0; private startedAt = 0;
      constructor(src = '') { this.src = src; }
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
  try {
    const obs = await obsContext.newPage();
    await obs.goto(`/stream?layout=overlay&audio=present#token=${encodeURIComponent(created.body.token)}`);
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.presenter.source, { timeout: 30000 }).toBe('show_link');
    await page.reload();

    // The narration prepares by itself; the bar's Publish sends it once the voice is ready. The director's playback controls sit under Show all.
    await expect(page.getByTestId('draft-audio-panel')).toBeVisible();
    await page.getByTestId('stage-show-all').evaluate(el => { (el as HTMLDetailsElement).open = true; });
    const publishAudio = page.getByTestId('publish');
    await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
    await expect(publishAudio).toBeEnabled();
    const latest = async () => {
      await expect.poll(async () => (await api(page, path)).body.history.length).toBeGreaterThan(0);
      return (await api(page, path)).body.history.at(-1);
    };
    return { obs, obsContext, publishAudio, latest, path };
  } catch (error) {
    await obsContext.close();
    throw error;
  }
}

test('the overlay shows every line of the latest beat after narration, players included', async ({ page, browser }) => {
  const lines = ['Mara, I heard the previous owner left in a hurry. Do you know where he went, or why he never came back?', 'And whatever happened to the ledger he kept behind the bar? Somebody must have seen it after he vanished.'];
  // One narration segment and one non-player line of about 30 words each, so the caption needs several chunks.
  const narration = 'Mara sets the glass down on the bar. She keeps her hand on it a moment, as if deciding whether the question deserves a fresh one. Rain ticks against the window behind her.';
  const reply = 'Previous is a strong word. Nobody has sold the place out from under him yet. He is missing. If anything says why, it will be his ledger, and he kept it close.';
  expect(narration.split(/\s+/).length).toBeGreaterThanOrEqual(28);
  expect(reply.split(/\s+/).length).toBeGreaterThanOrEqual(28);
  const { obs, obsContext, publishAudio, latest, path } = await setUpShow(page, browser, lines, { narration, reply });
  try {
    // From here the overlay page records which caption lines are on screen every 100 ms.
    await obs.evaluate(() => {
      const samples: { t: number; ids: string[] }[] = [];
      (window as any).__samples = samples;
      setInterval(() => {
        const ids = Array.from(document.querySelectorAll<HTMLElement>('.stage-story .line')).filter(line => !line.classList.contains('off-chunk')).map(line => line.dataset.segmentId!);
        samples.push({ t: Date.now(), ids });
      }, 100);
    });
    const start = Date.now();
    await publishAudio.click();
    // The main show link presents audio, so a voiced publish starts the shared playback by itself.
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).toBe('playing');
    await expect(page.getByTestId('start-audio')).toHaveCount(0);

    const published = await latest();
    expect(published.textOnly).toBe(false);
    const playerSegments = published.segments.filter((segment: any) => segment.kind === 'player_dialogue');
    expect(playerSegments).toHaveLength(2);
    expect(published.segments.filter((segment: any) => segment.kind !== 'player_dialogue')).toHaveLength(2);
    const segmentIds: string[] = published.segments.map((segment: any) => segment.id);
    await expect(obs.locator('.stage-story .line')).toHaveCount(segmentIds.length);

    // The director skips and stops the narration, then the overlay keeps running for about a minute in all.
    await page.waitForTimeout(8000);
    await page.getByTestId('skip-audio').click();
    await page.waitForTimeout(8000);
    await page.getByTestId('stop-audio').click();
    const rest = 60000 - (Date.now() - start);
    if (rest > 0) await page.waitForTimeout(rest);

    // Add up how long each line was on screen.
    const samples: { t: number; ids: string[] }[] = await obs.evaluate(() => (window as any).__samples);
    const visibleMs = new Map<string, number>();
    for (let index = 1; index < samples.length; index++) {
      const elapsed = Math.min(samples[index]!.t - samples[index - 1]!.t, 500);
      for (const id of samples[index - 1]!.ids) visibleMs.set(id, (visibleMs.get(id) ?? 0) + elapsed);
    }
    const report = segmentIds.map(id => `${id}=${visibleMs.get(id) ?? 0}ms`).join(' ');

    expect(segmentIds.filter(id => !visibleMs.has(id)), report).toEqual([]);
    for (const segment of playerSegments) expect(visibleMs.get(segment.id) ?? 0, `player line ${segment.text}: ${report}`).toBeGreaterThanOrEqual(4000);
  } finally { await obsContext.close(); }
});

test('short player lines that share a chunk with a short first narration line stay up for their reading time', async ({ page, browser }) => {
  const lines = ['Mara, where did the old owner go?', 'And what about the ledger he kept?'];
  const narration = 'She laughs.';
  const reply = 'Gone north, if you believe the dock talk. The ledger went with him, or so he wants us to think.';
  const { obs, obsContext, publishAudio, latest, path } = await setUpShow(page, browser, lines, { narration, reply });
  try {
    // From here the overlay page records, every 100 ms, which caption lines are shown, which are at full opacity, and which one is spoken.
    await obs.evaluate(() => {
      const samples: { t: number; shown: string[]; full: string[]; speaking: string | null }[] = [];
      (window as any).__samples = samples;
      setInterval(() => {
        const shown = Array.from(document.querySelectorAll<HTMLElement>('.stage-story .line')).filter(line => !line.classList.contains('off-chunk'));
        const full = shown.filter(line => getComputedStyle(line).opacity === '1');
        const speaking = document.querySelector<HTMLElement>('.stage-story .line.speaking')?.dataset.segmentId ?? null;
        samples.push({ t: Date.now(), shown: shown.map(line => line.dataset.segmentId!), full: full.map(line => line.dataset.segmentId!), speaking });
      }, 100);
    });
    await publishAudio.click();
    const published = await latest();
    expect(published.textOnly).toBe(false);
    expect(published.segments.map((segment: any) => segment.kind)).toEqual(['player_dialogue', 'player_dialogue', 'narration', 'npc_dialogue']);
    const [first, second, laugh, answer] = published.segments.map((segment: any) => segment.id as string);
    await expect(obs.locator('.stage-story .line')).toHaveCount(4);

    // The first chunk holds both player lines and the short narration line; the reply is on a later chunk.
    await expect.poll(async () => obs.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.stage-story .line'))
      .filter(line => !line.classList.contains('off-chunk')).map(line => line.dataset.segmentId))).toEqual([first, second, laugh]);

    // Playback starts by itself after publishing. The narrator voices the short line briefly, then the director skips to the reply and stops.
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).toBe('playing');
    await expect.poll(async () => obs.evaluate(() => document.querySelector<HTMLElement>('.stage-story .line.speaking')?.dataset.segmentId ?? null)).toBe(laugh);
    await page.waitForTimeout(1500);
    await page.getByTestId('skip-audio').click();
    await expect.poll(async () => obs.evaluate(() => document.querySelector<HTMLElement>('.stage-story .line.speaking')?.dataset.segmentId ?? null)).toBe(answer);
    await page.waitForTimeout(3000);
    await page.getByTestId('stop-audio').click();
    await expect.poll(async () => obs.evaluate(() => document.querySelector('.stage-story .line.speaking'))).toBeNull();
    // The reply chunk finishes its reading time, then the player chunk comes back for its own.
    await page.waitForTimeout(25000);

    const samples: { t: number; shown: string[]; full: string[]; speaking: string | null }[] = await obs.evaluate(() => (window as any).__samples);
    expect(samples.some(sample => sample.speaking === laugh && sample.shown.includes(first) && sample.shown.includes(second))).toBe(true);
    const report: string[] = [];
    for (const [id, text] of [[first, lines[0]!], [second, lines[1]!]] as const) {
      let run = 0;
      let longest = 0;
      let total = 0;
      for (let index = 1; index < samples.length; index++) {
        const elapsed = Math.min(samples[index]!.t - samples[index - 1]!.t, 500);
        if (samples[index - 1]!.full.includes(id)) {
          run += elapsed;
          total += elapsed;
          longest = Math.max(longest, run);
        } else run = 0;
      }
      const needed = Math.max(MIN_CHUNK_MS, (text.split(/\s+/).length / WORDS_PER_SECOND) * 1000);
      report.push(`${text}: longest ${longest}ms, total ${total}ms, needs ${needed}ms`);
      expect(longest, report.join('; ')).toBeGreaterThanOrEqual(needed);
    }
  } finally { await obsContext.close(); }
});
