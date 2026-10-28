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

const IDEA = 'tell mara the ledger is gone';
const ADA = 'eleven:fake-ada';

test('a player picks a voice, asks Help me say it, uses the suggestion and sends it: the voiced line shows no tags and plays in that voice', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const snapshot = async () => (await api(page, path)).body;

  // The director opens a round, and a test seat opens at phone width.
  await page.getByTestId('open-action').click();
  await expect.poll(async () => (await snapshot()).activeBeat?.kind).toBe('action');
  const state = await snapshot();
  const grant = await api(page, `${path}/test-seat`, { characterId: state.characters[0].id });
  expect(grant.status).toBe(200);
  const identity: string = grant.body.identityId;
  const seat = await context.newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${identity}`);

  // The player opens Your voice and chooses Ada. The sample button is never pressed.
  const voice = seat.getByTestId('seat-voice');
  await expect(voice).toBeVisible();
  await voice.getByText('Your voice', { exact: false }).first().click();
  const ada = voice.getByTestId('voice-option').filter({ hasText: 'Ada' });
  await expect(ada).toBeVisible();
  await ada.locator('.voice-choose').click();
  await expect.poll(async () => (await api(seat, path, undefined, identity)).body.ownCharacter?.voiceProfileId).toBe(ADA);
  await expect(voice.getByTestId('seat-voice-name')).toContainText('Ada');
  await expect(ada.locator('.voice-choose')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => seat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await seat.screenshot({ path: 'test-results/voices-seat-voice.png' });

  // Help me say it turns the rough idea into a suggestion; Use this puts it in the box; Send sends it.
  await seat.getByRole('button', { name: 'Say something', exact: true }).click();
  const box = seat.getByTestId('speech-input');
  await box.fill(IDEA);
  await seat.getByRole('button', { name: 'Help me say it', exact: true }).click();
  const suggestion = seat.getByTestId('line-assist-suggestion');
  await expect(suggestion).toBeVisible({ timeout: 30000 });
  const suggested = (await suggestion.locator('.line-assist-text').innerText()).trim();
  expect(suggested.startsWith('[warmly]'), suggested).toBe(true);
  expect(suggested).toContain(IDEA);
  await expect.poll(() => seat.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await seat.screenshot({ path: 'test-results/voices-seat-assist.png' });
  expect((await snapshot()).submissions.filter((s: any) => s.kind === 'say')).toHaveLength(0);
  await seat.getByRole('button', { name: 'Use this', exact: true }).click();
  await expect(suggestion).toHaveCount(0);
  await expect(box).toHaveValue(suggested);
  await seat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await snapshot()).submissions.filter((s: any) => s.kind === 'say').length).toBe(1);

  // The director ticks the line, plans, approves and rolls, drafts the scene, waits for the voice and publishes with voice.
  await page.reload();
  await expect(page.locator('.queue-item').filter({ hasText: IDEA }).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.getByTestId('stakes-cards')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Approve and roll', exact: true }).click();
  await expect(page.locator('.roll')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('player-lines')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
  await expect(page.getByTestId('publish')).toBeEnabled();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await snapshot()).history.length, { timeout: 30000 }).toBe(1);

  // The player's snapshot holds the chosen voice, and the published Say segment shows no tag but carries the voice.
  const own = (await api(seat, path, undefined, identity)).body.ownCharacter;
  expect(own.voiceProfileId).toBe(ADA);
  const published = (await snapshot()).history[0];
  expect(published.textOnly).toBe(false);
  const said = published.segments.find((s: any) => s.kind === 'player_dialogue');
  expect(said, 'a player_dialogue segment is published').toBeTruthy();
  expect(said.text).toContain(IDEA);
  expect(said.text).not.toContain('[warmly]');
  expect(said.text).not.toMatch(/\[[^\]]*\]/);
  expect(said.voiceProfileId).toBe(ADA);
  expect(said.voiceText ?? '').not.toBe('');

  // The manifest has the same spoken segments, and the Say segment plays in Ada's voice.
  const audio = await api(page, `${path}/audio/${published.id}`);
  expect(audio.status, JSON.stringify(audio.body).slice(0, 300)).toBe(200);
  const manifest: any[] = audio.body.manifest.segments;
  expect(manifest.map(s => s.id)).toEqual(published.segments.filter((s: any) => s.ttsEnabled).map((s: any) => s.id));
  expect(manifest.find(s => s.id === said.id)?.voiceProfileId).toBe(ADA);

  // The stream page shows the line without the tag, and no tag appears anywhere on it.
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const streamContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const overlay = await streamContext.newPage();
    await overlay.goto(`/stream?layout=overlay&audio=off#token=${encodeURIComponent(created.body.token)}`);
    const story = overlay.locator('.stage-story');
    await expect(story.locator('.line[data-segment-id]')).toHaveCount(published.segments.length);
    await expect(story.locator(`.line[data-segment-id="${said.id}"]`)).toContainText(IDEA);
    await expect(story).not.toContainText('[warmly]');
    expect(await overlay.locator('body').innerText()).not.toContain('[warmly]');
    expect(await overlay.content()).not.toContain('[warmly]');
  } finally {
    await streamContext.close();
  }
  await seat.close();
});
