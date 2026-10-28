import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

test.setTimeout(150000);

// The browser servers roll double 1s after a plan whose line starts with this marker.
const LINE = 'Double ones: Nice hat, Mara. Did you lose a bet?';

test('a Say line in a conversation round rolls double 1s: a critical failure everywhere, with no countdown tick', async ({ page, context, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const snapshot = async () => (await api(page, path)).body;

  // A test seat sends the Say line before any round is open.
  const state = await snapshot();
  expect(state.activeBeat).toBeNull();
  const countdowns = (tracks: any[]) => tracks.filter(track => track.kind === 'countdown');
  const countdownsBefore = countdowns(state.tracks);
  expect(countdownsBefore.length).toBeGreaterThan(0);
  const grant = await api(page, `${path}/test-seat`, { characterId: state.characters[0].id });
  expect(grant.status).toBe(200);
  const name: string = state.characters[0].name ?? state.characters[0].displayName;
  const seat = await context.newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${grant.body.identityId}`);
  await seat.getByRole('button', { name: 'Say something', exact: true }).click();
  await seat.getByTestId('speech-input').fill(LINE);
  await seat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await snapshot()).submissions.filter((s: any) => s.kind === 'say').length).toBe(1);

  // The director answers the line: the round stays a conversation and stops at What's at risk.
  await page.reload();
  await expect(page.locator('.queue-item').filter({ hasText: LINE }).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Answer these lines', exact: true }).click();
  const cards = page.getByTestId('stakes-cards');
  await expect(cards).toBeVisible({ timeout: 30000 });
  await expect(cards.getByText('Double 1s: Critical failure')).toBeVisible();
  await expect(cards.getByTestId('outcome-critical-read')).toContainText(/\S{3}/);
  expect((await snapshot()).activeBeat.kind).toBe('conversation');
  await page.screenshot({ path: 'test-results/every-line-rolls-stakes.png', fullPage: true });

  // Approving the stakes shows the wager, with the fourth row, on both stream pages.
  const more = page.getByTestId('beat-more');
  await more.getByText('More', { exact: true }).click();
  await page.getByTestId('approve-stakes').click();
  await expect.poll(async () => (await snapshot()).activeBeat?.stakesApproved).toBe(true);
  expect((await snapshot()).activeBeat.kind).toBe('conversation');
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const streamUrl = (layout: string) => `/stream?layout=${layout}&audio=off#token=${encodeURIComponent(created.body.token)}`;
  const overlayContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const sceneContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const overlay = await overlayContext.newPage();
    await overlay.goto(streamUrl('overlay'));
    await expect(overlay.locator('.wager')).toContainText('Double 1s Critical failure');
    await overlay.waitForTimeout(600);
    await overlay.screenshot({ path: 'test-results/every-line-rolls-wager.png' });
    const scene = await sceneContext.newPage();
    await scene.goto(streamUrl('scene'));
    await expect(scene.locator('.wager')).toContainText('Double 1s Critical failure');

    // Roll the dice, draft the scene, publish without voice.
    if (!(await page.getByTestId('lock').isVisible())) await more.getByText('More', { exact: true }).click();
    await page.getByTestId('lock').click();
    await expect.poll(async () => (await snapshot()).activeBeat?.resolution?.rolls.length, { timeout: 30000 }).toBe(1);
    await page.getByTestId('render').click();
    await expect(page.getByTestId('publish-text-only')).toBeEnabled({ timeout: 30000 });
    const directorRoll = page.locator('.rolls .roll');
    await expect(directorRoll).toHaveCount(1);
    await expect(directorRoll).toBeVisible();
    await expect(directorRoll.locator('small')).toContainText('Critical failure');
    await more.getByText('More', { exact: true }).click();
    await directorRoll.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'test-results/every-line-rolls-director.png' });
    await page.getByTestId('publish-text-only').click();
    await expect.poll(async () => (await snapshot()).history.length, { timeout: 30000 }).toBe(1);

    // The record: one critical roll on faces 1 and 1, a conversation round, no countdown tick.
    const after = await snapshot();
    const published = after.history[0];
    expect(published.kind).toBe('conversation');
    expect(published.rolls).toHaveLength(1);
    expect(published.rolls[0].faces).toEqual([1, 1]);
    expect(published.rolls[0].band).toBe('critical');
    expect(published.outcomes).toHaveLength(1);
    expect(published.outcomes[0].band).toBe('critical');
    expect(published.outcomes[0].goalAchieved).toBe(false);
    expect(after.session.actionRoundNumber).toBe(0);
    expect(countdowns(after.tracks)).toEqual(countdownsBefore);

    // The overlay and the full scene show the critical failure.
    await overlay.reload();
    const overlayRoll = overlay.locator('.roll[data-band="critical"]');
    await expect(overlayRoll).toHaveCount(1);
    await expect(overlayRoll).toContainText('Critical failure');
    await overlay.screenshot({ path: 'test-results/every-line-rolls-overlay.png' });
    await scene.reload();
    const sceneRoll = scene.locator('.roll[data-band="critical"]');
    await expect(sceneRoll).toHaveCount(1);
    await expect(sceneRoll).toContainText('Critical failure');
    await scene.screenshot({ path: 'test-results/every-line-rolls-scene.png' });
  } finally {
    await overlayContext.close();
    await sceneContext.close();
  }

  // The seat at phone width: the story shows the roll, with no sideways scroll.
  const roll = seat.getByTestId('seat-story').getByTestId('seat-story-roll');
  await expect(roll).toHaveCount(1);
  await expect(roll).toHaveText(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} rolled \\d+: Critical failure$`));
  await expect.poll(() => seat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await seat.screenshot({ path: 'test-results/every-line-rolls-seat.png' });
  await seat.close();
});
