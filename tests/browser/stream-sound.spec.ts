import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

type Show = {
  path: string;
  showToken: string;
  playerToken: string;
  latest: () => Promise<any>;
  publish: () => Promise<void>;
};

// Signs in as host, has two test seats each send one Say line, plans, locks and drafts the beat, and replaces the script with one
// narration segment and one non-player line. Returns the Main show link (made with the show) and a cast member's link.
async function setUpShow(page: Page): Promise<Show> {
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

  const lines = ['Mara, where did the old owner go?', 'And what about the ledger he kept?'];
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
    { kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: 'She laughs and sets the glass down.' },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: 'Gone north, if you believe the dock talk. The ledger went with him, or so he wants us to think.' },
  ] });

  const links = (await api(page, `${path}/stream-links`)).body.links as { id: string; subject: string; canPresent: boolean; revokedAt: string | null }[];
  const main = links.find(link => link.subject === 'show' && link.canPresent && !link.revokedAt);
  expect(main, 'every new show has a Main show link').toBeTruthy();
  const shown = await api(page, `${path}/stream-links/${main!.id}/link`);
  expect(shown.status).toBe(200);
  const player = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'player', characterId: state.characters[0].id });
  expect(player.status).toBe(200);
  expect(player.body.link.canPresent).toBe(false);

  const latest = async () => {
    await expect.poll(async () => (await api(page, path)).body.history.length).toBeGreaterThan(0);
    return (await api(page, path)).body.history.at(-1);
  };
  // The narration prepares by itself; the bar's Publish sends it once the voice is ready. The director's playback controls sit under Show all.
  const publish = async () => {
    await page.reload();
    await expect(page.getByTestId('draft-audio-panel')).toBeVisible();
    await page.getByTestId('stage-show-all').evaluate(el => { (el as HTMLDetailsElement).open = true; });
    await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
    await expect(page.getByTestId('publish')).toBeEnabled();
    await page.getByTestId('publish').click();
  };
  return { path, showToken: shown.body.token, playerToken: player.body.token, latest, publish };
}

// A browser context that looks like OBS (Open Broadcaster Software): window.obsstudio is set, and Audio is a test double that
// counts every clip made and every play() call on window.__audios and window.__plays.
async function fakeObs(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    (window as unknown as { obsstudio: object }).obsstudio = {};
    (window as any).__plays = 0;
    (window as any).__audios = 0;
    class TestAudio {
      src: string; paused = true; volume = 1; muted = false; duration = 120; readyState = 4;
      onended: null | (() => void) = null; onerror: null | (() => void) = null; onloadedmetadata: null | (() => void) = null;
      private position = 0; private startedAt = 0;
      constructor(src = '') { this.src = src; (window as any).__audios++; }
      get currentTime() { return this.position + (this.paused ? 0 : (performance.now() - this.startedAt) / 1000); }
      set currentTime(value: number) { this.position = value; this.startedAt = performance.now(); }
      play() { (window as any).__plays++; if (this.paused) { this.startedAt = performance.now(); this.paused = false; } return Promise.resolve(); }
      pause() { this.position = this.currentTime; this.paused = true; }
      load() {}
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }
      addEventListener() {}
      removeEventListener() {}
    }
    (window as any).Audio = TestAudio;
  });
  return context;
}

const streamPath = (query: string, token: string) => `/stream?${query}#token=${encodeURIComponent(token)}`;
const audioState = (page: Page) => page.getByTestId('broadcast-audio').getAttribute('data-state');
const counts = (page: Page) => page.evaluate(() => ({ plays: (window as any).__plays as number, audios: (window as any).__audios as number }));

// Counts the pixels that are not fully transparent in a screenshot taken with no page background, decoding it in the director page.
async function paintedPixels(director: Page, page: Page) {
  const png = (await page.screenshot({ omitBackground: true })).toString('base64');
  return director.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) painted++;
    return { painted, width: bitmap.width, height: bitmap.height };
  }, png);
}

test('the sound link presents on the Main show link and draws nothing, listens on a cast link, and a captions piece follows silently', async ({ page, browser }) => {
  test.setTimeout(180000);
  const show = await setUpShow(page);
  const { path } = show;
  const soundContext = await fakeObs(browser);
  const castContext = await fakeObs(browser);
  const captionsContext = await fakeObs(browser);
  try {
    // The Main show link's sound page presents the show audio.
    const sound = await soundContext.newPage();
    await sound.goto(streamPath('layout=audio', show.showToken));
    await expect(sound.locator('.stream-view')).toHaveAttribute('data-layout', 'audio');
    await expect.poll(() => audioState(sound), { timeout: 30000 }).toBe('presenting');
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.presenter.source, { timeout: 30000 }).toBe('show_link');

    // A cast member's link opened as a sound page in OBS never presents; it listens.
    const cast = await castContext.newPage();
    await cast.goto(streamPath('layout=audio', show.playerToken));
    await expect.poll(() => audioState(cast), { timeout: 30000 }).toBe('listening');

    // The captions piece from the Main show link follows the spoken line without sound.
    const captions = await captionsContext.newPage();
    await captions.goto(streamPath('view=captions', show.showToken));
    await expect(captions.locator('.stream-view')).toHaveAttribute('data-view', 'captions');
    await expect.poll(() => audioState(captions), { timeout: 30000 }).toBe('following');
    await captions.evaluate(() => {
      const states: string[] = [];
      (window as any).__states = states;
      setInterval(() => states.push(document.querySelector('[data-testid=broadcast-audio]')?.getAttribute('data-state') ?? 'gone'), 100);
    });

    // Publishing starts the narration by itself, because the sound page presents.
    await show.publish();
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).toBe('playing');
    const published = await show.latest();
    expect(published.textOnly).toBe(false);
    const segmentIds: string[] = published.segments.map((segment: any) => segment.id);
    expect(segmentIds.length).toBeGreaterThanOrEqual(3);
    await expect(captions.locator('.stage-story .line')).toHaveCount(segmentIds.length);

    // The captions piece marks the spoken line and follows each segment the director skips to.
    const speaking = () => captions.evaluate(() => document.querySelector<HTMLElement>('.stage-story .line.speaking')?.dataset.segmentId ?? null);
    for (let index = 0; index < segmentIds.length; index++) {
      await expect.poll(speaking, { timeout: 15000 }).toBe(segmentIds[index]);
      if (index < segmentIds.length - 1) await page.getByTestId('skip-audio').click();
    }

    // The cast page played the narration where it was opened, and never took over the show audio.
    expect((await counts(cast)).plays).toBeGreaterThan(0);
    expect(await audioState(cast)).toBe('listening');
    // The sound page played the narration for the stream.
    expect((await counts(sound)).plays).toBeGreaterThan(0);
    expect(await audioState(sound)).toBe('presenting');
    expect((await api(page, `${path}/playback`)).body.presenter.source).toBe('show_link');

    // The captions page never made a clip, never played one, and never presented.
    expect(await counts(captions)).toEqual({ plays: 0, audios: 0 });
    const states: string[] = await captions.evaluate(() => (window as any).__states);
    expect(states.length).toBeGreaterThan(20);
    expect([...new Set(states)]).toEqual(['following']);

    await page.getByTestId('stop-audio').click();
    await expect.poll(speaking).toBeNull();

    // The sound page draws nothing: a transparent page with no pixel painted, and no visible element.
    await expect(sound.locator('html')).toHaveClass(/stage-transparent/);
    const visible = await sound.evaluate(() => Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const drawn = (element.childElementCount === 0 && (element.textContent ?? '').trim() !== '') || ['IMG', 'CANVAS', 'VIDEO', 'SVG'].includes(element.tagName.toUpperCase());
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && drawn;
    }).map(element => element.outerHTML.slice(0, 120)));
    expect(visible).toEqual([]);
    expect(await sound.locator('.stage-canvas').count()).toBe(0);
    const pixels = await paintedPixels(page, sound);
    expect(pixels.width).toBeGreaterThan(0);
    expect(pixels.painted).toBe(0);
  } finally {
    await Promise.all([soundContext.close(), castContext.close(), captionsContext.close()]);
  }
});

const MEASURE_MS = 60000;
type Group = 'stage snapshot' | 'playback' | 'stream access' | 'images' | 'other';

function groupOf(url: URL, resourceType: string): Group {
  if (url.pathname === '/api/stream/access') return 'stream access';
  if (/^\/api\/sessions\/[^/]+\/(playback|audio)(\/|$)/.test(url.pathname)) return 'playback';
  if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) return 'stage snapshot';
  if (resourceType === 'image') return 'images';
  return 'other';
}

// Records each page's requests by group and path, its WebSockets, and its JavaScript heap (through the Chrome DevTools Protocol).
async function watch(page: Page, name: string) {
  const state = { counting: false, groups: {} as Record<Group, number>, paths: {} as Record<string, number>, sinceOpen: {} as Record<Group, number>, sockets: [] as { closed: boolean }[] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      const opened = groupOf(url, request.resourceType());
      state.sinceOpen[opened] = (state.sinceOpen[opened] ?? 0) + 1;
    }
    if (!state.counting) return;
    const group = groupOf(url, request.resourceType());
    state.groups[group] = (state.groups[group] ?? 0) + 1;
    const key = `${request.method()} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id').replace(/[A-Za-z0-9_-]{24,}/g, ':id')}`;
    state.paths[key] = (state.paths[key] ?? 0) + 1;
  });
  page.on('websocket', socket => {
    const entry = { closed: false };
    state.sockets.push(entry);
    socket.on('close', () => { entry.closed = true; });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heaps: number[] = [];
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const value = metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? 0;
    heaps.push(value);
    return value;
  };
  return {
    name, heap,
    start() { state.counting = true; },
    stop() { state.counting = false; },
    report(elapsedMs: number) {
      const total = Object.values(state.groups).reduce((sum, value) => sum + value, 0);
      const perMinute = (value: number) => Math.round((value * 60000 / elapsedMs) * 10) / 10;
      return {
        page: name,
        requestsPerMinute: perMinute(total),
        byGroup: Object.fromEntries((['stage snapshot', 'playback', 'stream access', 'images', 'other'] as Group[]).map(group => [group, perMinute(state.groups[group] ?? 0)])),
        byPath: Object.fromEntries(Object.entries(state.paths).sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, perMinute(value)])),
        apiRequestsSinceOpen: { ...state.sinceOpen },
        openSockets: state.sockets.filter(socket => !socket.closed).length,
        socketsOpened: state.sockets.length,
        heapMB: { end: Math.round(heaps.at(-1)! / 1048576 * 10) / 10, peak: Math.round(Math.max(...heaps) / 1048576 * 10) / 10 },
      };
    },
  };
}

type Watched = Awaited<ReturnType<typeof watch>>;

// Counts for one minute while the director replays the voiced beat and skips through it, reading each page's heap every ten seconds.
async function measureMinute(director: Page, path: string, watched: Watched[]) {
  for (const item of watched) await item.heap();
  const started = Date.now();
  for (const item of watched) item.start();
  const sampler = setInterval(() => { for (const item of watched) void item.heap().catch(() => undefined); }, 10000);
  try {
    const replay = director.getByTestId('replay-audio');
    await expect(replay).toBeEnabled({ timeout: 20000 });
    await replay.click();
    await expect.poll(async () => (await api(director, `${path}/playback`)).body.status, { timeout: 20000 }).toBe('playing');
    for (let skips = 0; skips < 6; skips++) {
      await director.waitForTimeout(4000);
      const playback = (await api(director, `${path}/playback`)).body;
      if (playback.status !== 'playing') break;
      const skip = director.getByTestId('skip-audio');
      if (await skip.isVisible() && await skip.isEnabled()) await skip.click();
    }
    const rest = MEASURE_MS - (Date.now() - started);
    if (rest > 0) await director.waitForTimeout(rest);
  } finally {
    clearInterval(sampler);
  }
  for (const item of watched) item.stop();
  const elapsed = Date.now() - started;
  for (const item of watched) await item.heap();
  return { elapsedMs: elapsed, pages: watched.map(item => item.report(elapsed)) };
}

test('load: the sound page and eight pieces against one old overlay page', async ({ page, browser }) => {
  test.skip(process.env.MEASURE_LOAD !== '1', 'Runs only when MEASURE_LOAD=1.');
  test.setTimeout(360000);
  const show = await setUpShow(page);
  const { path } = show;
  const obs = await fakeObs(browser);
  const overlayContext = await fakeObs(browser);
  try {
    const sound = await obs.newPage();
    const watched: Watched[] = [await watch(sound, 'sound (layout=audio)')];
    await sound.goto(streamPath('layout=audio', show.showToken));
    await expect.poll(() => audioState(sound), { timeout: 30000 }).toBe('presenting');
    const pieces = ['captions', 'dice', 'stakes', 'party', 'tracks', 'picture', 'badge', 'facts'];
    const piecePages: Record<string, Page> = {};
    for (const view of pieces) {
      const piece = await obs.newPage();
      watched.push(await watch(piece, `piece ${view}`));
      await piece.goto(streamPath(`view=${view}`, show.showToken));
      await expect(piece.locator('.stream-view')).toHaveAttribute('data-view', view);
      piecePages[view] = piece;
    }
    await expect.poll(() => audioState(piecePages.captions!), { timeout: 30000 }).toBe('following');

    await show.publish();
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).toBe('playing');
    const published = await show.latest();
    await expect(piecePages.captions!.locator('.stage-story .line')).toHaveCount(published.segments.length);
    await page.getByTestId('stop-audio').click();
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).not.toBe('playing');

    const pieceRun = await measureMinute(page, path, watched);
    const silentPlays = await Promise.all(pieces.map(async view => ({ view, ...(await counts(piecePages[view]!)) })));
    for (const item of silentPlays) expect(item, `${item.view} played sound`).toMatchObject({ plays: 0, audios: 0 });
    await page.getByTestId('stop-audio').click().catch(() => undefined);
    for (const view of pieces) await piecePages[view]!.close();

    // The same minute for one old overlay link that listens, with the sound page still presenting (unmeasured) so replay works.
    const overlay = await overlayContext.newPage();
    const overlayWatch = await watch(overlay, 'old overlay (layout=overlay&audio=listen)');
    await overlay.goto(streamPath('layout=overlay&audio=listen', show.showToken));
    await expect.poll(() => audioState(overlay), { timeout: 30000 }).toBe('listening');
    await expect(overlay.locator('.stage-story .line')).toHaveCount(published.segments.length);
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.status, { timeout: 20000 }).not.toBe('playing');
    const overlayRun = await measureMinute(page, path, [overlayWatch]);

    const sum = (rows: { requestsPerMinute: number; heapMB: { end: number } }[]) => ({
      requestsPerMinute: Math.round(rows.reduce((total, row) => total + row.requestsPerMinute, 0) * 10) / 10,
      heapMB: Math.round(rows.reduce((total, row) => total + row.heapMB.end, 0) * 10) / 10,
    });
    const result = {
      measuredAt: new Date().toISOString(),
      browser: `Chromium ${browser.version()} (Playwright, headless, Linux)`,
      windowMs: MEASURE_MS,
      pieces: { ...pieceRun, total: sum(pieceRun.pages), piecesOnly: sum(pieceRun.pages.slice(1)) },
      oldOverlay: { ...overlayRun, total: sum(overlayRun.pages) },
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/stream-pieces-load.json', `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    expect(pieceRun.pages).toHaveLength(9);
    for (const row of pieceRun.pages) expect(row.heapMB.end).toBeGreaterThan(0);
  } finally {
    await Promise.all([obs.close(), overlayContext.close()]);
  }
});
