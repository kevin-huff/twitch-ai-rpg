import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, {
      headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

// An image counts as drawn when the browser decoded it, so a broken link or an empty file fails here.
async function expectPicture(image: ReturnType<Page['locator']>) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

test('a player makes a portrait on the pre-show page, it shows on the director seat line and on the stream', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: crypto.randomUUID(), expectedVersion: 0,
    definition: { ...starter.scenario, title: `Portrait cards ${Date.now()}`, boundaries: ['No graphic injury'] },
  });

  // Step 1: a custom show where both seats are written by their players. Creating it lands on Cast & lobby.
  await page.getByTestId('library-link').click();
  await page.getByTestId('show-title').fill('Portrait night');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  for (const index of [0, 1]) await expect(page.getByTestId(`show-seat-${index}`)).toHaveValue('player');
  await page.getByTestId('create-custom').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.picturesEnabled).toBe(true);
  const ids: string[] = snapshot.characterDetails.map((character: { id: string }) => character.id);
  expect(ids).toHaveLength(2);

  // Step 2: seat 1 writes a short card, makes a portrait, tries once more, and uses the second picture.
  const popup1 = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Test as Seat 1 ↗', exact: true }).click();
  const seat1 = await popup1;
  await expect(seat1.getByTestId('pre-show')).toBeVisible();
  await expect(seat1.getByRole('heading', { name: 'Your character', exact: true })).toBeVisible();
  await seat1.getByTestId('card-description').fill('A clever archivist, she/her, who hides a debt');
  await seat1.getByTestId('write-card').click();
  await expect(seat1.getByTestId('card-summary')).toBeVisible();
  await expect(seat1.getByTestId('card-name')).not.toHaveValue('');
  const name1 = await seat1.getByTestId('card-name').inputValue();
  await seat1.getByTestId('card-more').getByText('More about your character', { exact: true }).click();
  await seat1.getByLabel('Appearance', { exact: true }).fill('Tall, with ink-stained fingers and a long green coat.');

  await expect(seat1.getByTestId('portrait-placeholder')).toBeVisible();
  await seat1.getByTestId('portrait-create').click();
  await expect(seat1.getByTestId('portrait-create')).toHaveText('Making the portrait...');
  await expectPicture(seat1.getByTestId('portrait-preview'));
  await expect(seat1.getByTestId('portrait-preview')).toHaveAttribute('alt', `Portrait of ${name1}`);
  const first = await seat1.getByTestId('portrait-preview').getAttribute('src');
  await seat1.getByTestId('portrait-retry').click();
  await expect(seat1.getByTestId('portrait-retry')).toBeEnabled();
  await expect.poll(async () => seat1.getByTestId('portrait-preview').getAttribute('src')).not.toBe(first);
  await expectPicture(seat1.getByTestId('portrait-preview'));
  const chosen = await seat1.getByTestId('portrait-preview').getAttribute('src');
  await seat1.getByTestId('portrait-use').click();
  await expect(seat1.getByTestId('portrait-preview')).toHaveCount(0);
  await expectPicture(seat1.getByTestId('portrait-current'));
  await expect(seat1.getByTestId('portrait-current')).toHaveAttribute('src', chosen!);
  await expect(seat1.getByTestId('portrait-remove')).toBeVisible();
  await expect(seat1.getByTestId('save-character-draft')).toBeEnabled();
  await seat1.getByTestId('save-character-draft').click();

  // Step 3: the card applies at once. No approval step: the director sees the portrait on the seat line.
  const line = page.getByTestId(`seat-line-${ids[0]}`);
  await expect(line.locator('.picture-avatar img')).toHaveAttribute('alt', `Portrait of ${name1}`);
  await expectPicture(line.locator('.picture-avatar img'));
  await line.getByText('Read card', { exact: true }).click();
  await expect(line.getByText('Tall, with ink-stained fingers and a long green coat.')).toBeVisible();
  await expect(seat1.getByTestId('player-card').locator('.picture-avatar img')).toHaveAttribute('alt', `Portrait of ${name1}`);
  await expectPicture(seat1.getByTestId('player-card').locator('.picture-avatar img'));

  // Step 4: seat 2 writes a plain card. There is nothing to approve and nobody has to press ready.
  const popup2 = context.waitForEvent('page');
  await page.getByRole('link', { name: /^Test as Seat 2/ }).click();
  const seat2 = await popup2;
  await expect(seat2.getByTestId('pre-show')).toBeVisible();
  await seat2.getByTestId('card-description').fill('A charming singer, she/her, who owes a debt');
  await seat2.getByTestId('write-card').click();
  await expect(seat2.getByTestId('card-summary')).toBeVisible();
  await expect(seat2.getByTestId('card-name')).not.toHaveValue('');
  await seat2.getByTestId('save-character-draft').click();
  await expect(page.getByTestId('seats-with-card')).toContainText('2 of 2');
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);

  // Step 5: Start show lands on the director page. The main show link already exists. Its full scene stream shows the portrait on the character's party card.
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/director/);
  await page.getByTestId('stream-this-show').click();
  await expect(page.getByTestId('stream-setup')).toHaveAttribute('open', '');
  const url = (await page.getByTestId('stream-row-show').getByTestId('copy-scene').getAttribute('data-url'))!;
  const viewer = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const stream = await viewer.newPage();
    await stream.goto(url);
    const card = stream.locator('.party-card').filter({ hasText: name1 });
    await expectPicture(card.locator('img.party-portrait'));
    await expect(card.locator('img.party-portrait')).toHaveAttribute('alt', `Portrait of ${name1}`);
    await expect(stream.locator('.party-card img.party-portrait')).toHaveCount(1);
  } finally {
    await viewer.close();
  }
});
