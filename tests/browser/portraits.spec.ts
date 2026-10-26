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

test('a player makes a portrait in Cast & lobby, the director approves it, and it shows in the cast list and on the stream', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: crypto.randomUUID(), expectedVersion: 0,
    definition: { ...starter.scenario, title: `Portrait cards ${Date.now()}`, boundaries: ['No graphic injury'] },
  });

  // Step 1: a custom show where both seats are written by their players.
  await page.getByTestId('library-link').click();
  await page.getByTestId('show-title').fill('Portrait night');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  for (const index of [0, 1]) await expect(page.getByTestId(`show-seat-${index}`)).toHaveValue('player');
  await page.getByTestId('create-custom').click();
  await page.getByTestId('custom-lobby-link').click();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.picturesEnabled).toBe(true);
  const ids: string[] = snapshot.characterDetails.map((character: { id: string }) => character.id);
  expect(ids).toHaveLength(2);

  // Step 2: seat 1 writes a card, makes a portrait, tries once more, and uses the second picture.
  const popup1 = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Test as Seat 1 ↗', exact: true }).click();
  const seat1 = await popup1;
  await seat1.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
  await expect(seat1.getByRole('heading', { name: 'Write your character', exact: true })).toBeVisible();
  await seat1.getByTestId('card-generator-open').click();
  await seat1.getByTestId('card-generator-prompt').fill('A clever archivist, she/her, who hides a debt');
  await seat1.getByTestId('card-generator-generate').click();
  await expect(seat1.getByTestId('card-generator-preview')).toContainText('Pronouns: she/her');
  await seat1.getByTestId('card-generator-apply').click();
  await expect(seat1.getByTestId('card-name')).not.toHaveValue('');
  const name1 = await seat1.getByTestId('card-name').inputValue();
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

  // Step 3: the director sees the portrait in Review the cast and approves the card.
  const review = page.locator('.card-review').filter({ hasText: name1 });
  await expect(review.locator('img.review-portrait')).toHaveAttribute('alt', `Portrait of ${name1}`);
  await expectPicture(review.locator('img.review-portrait'));
  await page.getByTestId(`approve-character-${ids[0]}`).click();
  await expect(seat1.getByText('Your card is approved.', { exact: true })).toBeVisible();
  await expect(seat1.getByText('Unsaved card changes', { exact: false })).toHaveCount(0);

  // Step 4: the cast list shows the approved portrait to the director and to the player.
  for (const viewer of [page, seat1]) {
    const avatar = viewer.locator('.cast-person').filter({ hasText: name1 }).locator('.avatar img');
    await expectPicture(avatar);
    await expect(avatar).toHaveAttribute('alt', `Portrait of ${name1}`);
  }

  // Step 5: seat 2 writes a plain card, the director approves it, and both players get ready.
  const popup2 = context.waitForEvent('page');
  await page.getByRole('link', { name: /^Test as Seat 2/ }).click();
  const seat2 = await popup2;
  await seat2.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
  await seat2.getByTestId('card-generator-open').click();
  await seat2.getByTestId('card-generator-prompt').fill('A charming singer, she/her, who owes a debt');
  await seat2.getByTestId('card-generator-generate').click();
  await seat2.getByTestId('card-generator-apply').click();
  await expect(seat2.getByTestId('card-name')).not.toHaveValue('');
  await seat2.getByTestId('save-character-draft').click();
  await page.getByTestId(`approve-character-${ids[1]}`).click();
  for (const player of [seat1, seat2]) {
    await expect(player.getByText('Your card is approved.', { exact: true })).toBeVisible();
    await player.getByTestId('accept-boundaries').check();
    await player.getByTestId('ready-character').click();
    await expect(player.getByText('You are ready for this version of the boundaries.', { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.getByTestId('start-session').click();
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);

  // Step 6: the main show link's full scene stream shows the portrait on the character's party card.
  await page.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
  await page.getByRole('button', { name: 'Show stage & OBS links' }).click();
  await page.getByRole('button', { name: 'Create main show link' }).click();
  const showRow = page.locator('.link-row').filter({ hasText: 'The whole show' });
  await showRow.getByLabel('Layout').selectOption({ label: 'Full scene (1920×1080)' });
  const url = await showRow.getByLabel('Link address').inputValue();
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
