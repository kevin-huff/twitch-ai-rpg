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

const ACTION = 'I climb the fire escape and look in the window.';
const SPEECH = 'Is anyone up there?';

test('a player sends Do and Say in one round: two rolls, a voiced publish, and both lines on stream and on the seat', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const snapshot = async () => (await api(page, path)).body;

  // Open an action round, then the player sends an action and a spoken line.
  await page.getByTestId('open-action').click();
  await expect.poll(async () => (await snapshot()).activeBeat?.kind).toBe('action');
  const state = await snapshot();
  const grant = await api(page, `${path}/test-seat`, { characterId: state.characters[0].id });
  expect(grant.status).toBe(200);
  const seat = await context.newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${grant.body.identityId}`);
  await expect(seat.getByTestId('seat-story-empty')).toBeVisible();

  await seat.getByRole('button', { name: 'Do something', exact: true }).click();
  await seat.getByTestId('action-input').fill(ACTION);
  await seat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await snapshot()).submissions.filter((s: any) => s.kind === 'act').length).toBe(1);
  await seat.getByRole('button', { name: 'Say something', exact: true }).click();
  await seat.getByTestId('speech-input').fill(SPEECH);
  await seat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await snapshot()).submissions.filter((s: any) => s.kind === 'say').length).toBe(1);

  // The director plans, approves and rolls: one roll for each line.
  await page.reload();
  await expect(page.locator('.queue-item').filter({ hasText: SPEECH }).getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.queue-item').filter({ hasText: ACTION }).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByTestId('stakes-cards')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Approve and roll', exact: true }).click();
  await expect(page.locator('.roll')).toHaveCount(2, { timeout: 30000 });
  await expect(page.getByTestId('player-lines')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
  await expect(page.getByTestId('publish')).toBeEnabled();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await snapshot()).history.length, { timeout: 30000 }).toBe(1);

  // The published beat holds both player lines word for word, first, and every segment is voiced.
  const published = (await snapshot()).history[0];
  expect(published.textOnly).toBe(false);
  expect(published.rolls).toHaveLength(2);
  expect(published.segments.slice(0, 2).map((s: any) => [s.kind, s.text])).toEqual([['player_action', ACTION], ['player_dialogue', SPEECH]]);
  expect(published.segments.length).toBeGreaterThan(2);
  for (const segment of published.segments) expect(segment.ttsEnabled, `${segment.kind} is voiced`).toBe(true);
  const audio = await api(page, `${path}/audio/${published.id}`);
  expect(audio.status, JSON.stringify(audio.body).slice(0, 300)).toBe(200);
  expect(audio.body.manifest.segments.map((s: any) => s.id)).toEqual(published.segments.map((s: any) => s.id));
  const actionSegment = published.segments[0];
  const speechSegment = published.segments[1];

  // The main show link, at 1920x1080 with the sound off.
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const streamUrl = (layout: string) => `/stream?layout=${layout}&audio=off#token=${encodeURIComponent(created.body.token)}`;
  const overlayContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const sceneContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const overlay = await overlayContext.newPage();
    await overlay.goto(streamUrl('overlay'));
    const story = overlay.locator('.stage-story');
    await expect(story.locator('.line[data-segment-id]')).toHaveCount(published.segments.length);
    await expect(story).toContainText(ACTION);
    await expect(story).toContainText(SPEECH);
    const overlayAction = story.locator(`.line[data-segment-id="${actionSegment.id}"]`);
    await expect(overlayAction).toHaveClass(/\bplayer\b/);
    await expect(overlayAction).toHaveClass(/\baction\b/);
    await expect(overlayAction.locator('.line-tag')).toHaveText('Action');
    await expect(story.locator(`.line[data-segment-id="${speechSegment.id}"] .line-tag`)).toHaveCount(0);
    await expect(story.locator('.line.narration .who')).toHaveCount(0);
    await expect(story.locator('.line.narration').first()).toBeAttached();
    await overlay.screenshot({ path: 'test-results/player-lines-overlay.png' });

    const scene = await sceneContext.newPage();
    await scene.goto(streamUrl('scene'));
    await expect(scene.locator('.scene .line')).toHaveCount(published.segments.length);
    const sceneStory = scene.locator('.stage-story');
    await expect(sceneStory).toContainText(ACTION);
    await expect(sceneStory).toContainText(SPEECH);
    const sceneAction = scene.locator(`.scene .line[data-segment-id="${actionSegment.id}"]`);
    await expect(sceneAction).toHaveClass(/player_action/);
    await expect(sceneAction.locator('.line-role')).toHaveText('Action');
    await expect(sceneAction.locator('.line-text')).toHaveText(ACTION);
    await expect(scene.locator(`.scene .line[data-segment-id="${speechSegment.id}"] .line-role`)).toHaveText('Player');
    await scene.screenshot({ path: 'test-results/player-lines-scene.png' });
  } finally {
    await overlayContext.close();
    await sceneContext.close();
  }

  // The seat at phone width: the story panel shows both lines and both rolls, and the whole story opens and closes.
  await expect(seat.getByTestId('seat-story-empty')).toHaveCount(0);
  const panel = seat.getByTestId('seat-story');
  await expect(panel).toBeVisible();
  const lines = panel.getByTestId('seat-story-line');
  await expect(lines.filter({ hasText: ACTION })).toHaveCount(1);
  await expect(lines.filter({ hasText: SPEECH })).toHaveCount(1);
  await expect(lines.filter({ hasText: ACTION }).locator('.seat-story-tag')).toHaveText('Action');
  await expect(lines.filter({ hasText: SPEECH }).locator('.seat-story-tag')).toHaveCount(0);
  await expect(panel.getByTestId('seat-story-roll')).toHaveCount(2);
  await expect(panel.getByTestId('seat-story-roll').first()).toHaveText(/ rolled \d+: \S/);
  const lineTexts = await lines.allInnerTexts();
  expect(lineTexts[0]).toContain(ACTION);
  expect(lineTexts[1]).toContain(SPEECH);
  const toggle = panel.getByTestId('whole-story-toggle');
  await expect(toggle).toHaveText('Show the whole story');
  await toggle.click();
  await expect(toggle).toHaveText('Hide the whole story');
  await expect(panel.getByTestId('seat-story-beat').first()).toContainText('Beat 1');
  await expect(lines.filter({ hasText: ACTION })).toHaveCount(1);
  await expect.poll(() => seat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await seat.screenshot({ path: 'test-results/player-lines-seat-open.png' });
  await toggle.click();
  await expect(toggle).toHaveText('Show the whole story');
  await expect(panel.getByTestId('seat-story-beat')).toHaveCount(1);
  await expect.poll(() => seat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await seat.screenshot({ path: 'test-results/player-lines-seat.png' });
  await seat.close();
});
