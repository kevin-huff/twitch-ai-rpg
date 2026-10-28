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

// Signs in as host and presses Try it now. Returns the show's id and a command helper that sends as the host or as a Test as seat.
async function startPracticeShow(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const snapshot = async () => (await api(page, path)).body;
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    expect(result.status, JSON.stringify(result.body).slice(0, 300)).toBe(200);
    return result.body.snapshot;
  };
  const seat = async (characterId: string) => {
    const grant = await api(page, `${path}/test-seat`, { characterId });
    expect(grant.status).toBe(200);
    return grant.body.identityId as string;
  };
  return { sessionId, path, snapshot, command, seat };
}

// Loads the main show link in a 1920x1080 browser that looks like OBS (Open Broadcaster Software) and presents the show audio.
async function openObs(page: Page, browser: Browser, path: string) {
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
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
    const obs = await context.newPage();
    await obs.goto(`/stream?layout=overlay&audio=present#token=${encodeURIComponent(created.body.token)}`);
    await expect.poll(async () => (await api(page, `${path}/playback`)).body.presenter.source, { timeout: 30000 }).toBe('show_link');
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

test('Answer these lines, Approve and roll, then Publish, starts the narration on the main show link with no Play press', async ({ page, browser }) => {
  const show = await startPracticeShow(page);
  const obsContext = await openObs(page, browser, show.path);
  try {
    // A cast member sends a line before any beat is open.
    const state = await show.snapshot();
    const seat = await show.seat(state.characters[0].id);
    const npc = state.npcs.find((item: any) => item.status === 'present');
    const text = 'Mara, who ran this place before you did?';
    await show.command({ type: 'save_submission', contextBeatId: null, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text, recipientNpcIds: [npc.id] }, seat);

    // The line arrives ticked, so Answer these lines is ready without selecting anything.
    await page.reload();
    const line = page.locator('.queue-item').filter({ hasText: text });
    await expect(line).toBeVisible();
    await expect(line.getByRole('checkbox')).toBeChecked();
    const answer = page.getByRole('button', { name: 'Answer these lines', exact: true });
    await expect(answer).toBeEnabled();
    await answer.click();

    // The round stops at What's at risk; the director approves the stakes and rolls.
    await expect(page.getByTestId('stakes-cards')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('approve-and-roll').click();

    // The script is written and waiting for the director's read.
    const publish = page.getByTestId('publish');
    await expect(publish).toBeVisible({ timeout: 30000 });
    await expect(publish).toBeEnabled({ timeout: 30000 });
    await publish.click();

    // The shared player starts on its own: no Play press.
    await expect.poll(async () => {
      const playback = (await api(page, `${show.path}/playback`)).body;
      return ['playing', 'complete'].includes(playback.status) && playback.manifest ? playback.manifest.beatId : null;
    }, { timeout: 30000 }).not.toBeNull();
    const published = (await show.snapshot()).history.at(-1);
    expect(published.textOnly).toBe(false);
    const playback = (await api(page, `${show.path}/playback`)).body;
    expect(playback.manifest.beatId).toBe(published.id);
  } finally { await obsContext.close(); }
});

test('Approve and roll rolls once, Regenerate script keeps the roll, and Publish without voice finishes the round', async ({ page }) => {
  const show = await startPracticeShow(page);
  await page.getByTestId('open-action').click();
  await expect.poll(async () => (await show.snapshot()).activeBeat?.kind).toBe('action');
  const state = await show.snapshot();
  const seat = await show.seat(state.characters[0].id);
  await show.command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: 'Search the dock for the missing ledger', approach: 'Careful investigation' }, seat);

  await page.reload();
  const line = page.locator('.queue-item').filter({ hasText: 'Search the dock for the missing ledger' });
  await expect(line.getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();

  // The stakes card shows the roll in words before anything is rolled.
  const stakes = page.getByTestId('stakes-cards');
  await expect(stakes.getByRole('heading', { name: "What's at risk" })).toBeVisible();
  await expect(stakes.getByText(/^Roll: two dice \+ \w+ \([+-]\d+\)/)).toBeVisible();
  await expect(page.locator('.roll')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve and roll', exact: true }).click();
  await expect(page.locator('.roll')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('publish')).toBeEnabled({ timeout: 30000 });
  const before = (await show.snapshot()).activeBeat;
  const rolled = before.resolution.rolls;
  expect(rolled).toHaveLength(1);
  expect(before.draft).not.toBeNull();
  const rollText = await page.locator('.roll').innerText();

  // Regenerate script under More: the confirmation says the dice stay, and they do.
  await page.getByTestId('beat-more').getByText('More', { exact: true }).click();
  await page.getByTestId('regenerate').click();
  await page.getByRole('button', { name: 'Yes, regenerate' }).click();
  // The new script has really been written: a later draft revision with a draft in place.
  await expect.poll(async () => {
    const beat = (await show.snapshot()).activeBeat;
    return beat && beat.draft && beat.draftRevision > before.draftRevision && beat.generation > before.generation;
  }, { timeout: 30000 }).toBe(true);
  await expect(page.getByTestId('publish')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.roll')).toHaveCount(1);
  expect(await page.locator('.roll').innerText()).toBe(rollText);
  expect((await show.snapshot()).activeBeat.resolution.rolls).toEqual(rolled);

  await page.getByTestId('publish-text-only').click();
  await expect.poll(async () => (await show.snapshot()).history.at(-1)?.textOnly, { timeout: 30000 }).toBe(true);
  expect((await show.snapshot()).activeBeat).toBeNull();
});

test('End show asks first, Keep going cancels, and the ended show leads with its gallery', async ({ page }) => {
  await startPracticeShow(page);
  await expect(page.getByTestId('show-state')).toHaveText('Live');
  await expect(page.getByTestId('gallery-panel')).toHaveCount(0);

  await page.getByTestId('end-show').click();
  await expect(page.getByTestId('end-show-confirm-row')).toContainText("End the show? Players will see that it's over, and it can't be restarted.");
  await page.getByTestId('end-show-keep').click();
  await expect(page.getByTestId('end-show-confirm-row')).toHaveCount(0);
  await expect(page.getByTestId('show-state')).toHaveText('Live');

  await page.getByTestId('end-show').click();
  await page.getByTestId('end-show-confirm').click();
  await expect(page.getByTestId('show-state')).toHaveText('Ended');
  await expect(page.getByTestId('end-show')).toHaveCount(0);
  await expect(page.getByTestId('top-pause')).toHaveCount(0);
  await expect(page.getByTestId('beat-next')).toHaveCount(0);

  const gallery = page.getByTestId('ended-gallery');
  await expect(gallery.getByTestId('gallery-panel')).toBeVisible();
  await gallery.getByTestId('gallery-on').click();
  await expect(gallery.getByText('Gallery link', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(gallery.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
});
