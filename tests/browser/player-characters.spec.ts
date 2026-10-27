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

test('players write their own short cards on the pre-show page, they apply at once, and the show can start', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: crypto.randomUUID(), expectedVersion: 0,
    definition: { ...starter.scenario, title: `Player cards ${Date.now()}`, boundaries: ['No graphic injury'] },
  });

  // Step 1: both seats default to a player-written card. Creating the show lands on Cast & lobby, with both seats waiting.
  await page.getByTestId('library-link').click();
  await page.getByTestId('show-title').fill('Friday at the Lighthouse');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  for (const index of [0, 1]) {
    const seat = page.getByTestId(`show-seat-${index}`);
    await expect(seat).toHaveValue('player');
    await expect(seat.locator('option').first()).toHaveText('Player writes their own character');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const seatSelect = await page.getByTestId('show-seat-0').boundingBox();
  const removeSeat = await page.getByRole('button', { name: 'Remove seat' }).first().boundingBox();
  expect(seatSelect!.width).toBeGreaterThanOrEqual(300);
  expect(removeSeat!.y).toBeGreaterThanOrEqual(seatSelect!.y + seatSelect!.height - 1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByTestId('create-custom').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.setup.started).toBe(false);
  const ids: string[] = snapshot.characterDetails.map((character: { id: string }) => character.id);
  expect(ids).toHaveLength(2);
  for (const id of ids) await expect(page.getByTestId(`waiting-for-card-${id}`)).toHaveText("Waiting for this player's card");
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 0 of 2');
  await expect(page.getByTestId('start-session')).toBeDisabled();

  // Step 2: seat 1 opens the pre-show page, which shows the short card: a name, a description, and the rest folded away.
  const popup1 = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Test as Seat 1 ↗', exact: true }).click();
  const seat1 = await popup1;
  await expect(seat1.getByTestId('pre-show')).toBeVisible();
  await expect(seat1.getByRole('heading', { name: 'Your character', exact: true })).toBeVisible();
  await expect(seat1.getByText('The show will start soon.', { exact: true })).toBeVisible();
  await expect(seat1.getByTestId('card-name')).toHaveValue('');
  await expect(seat1.getByTestId('card-name-only')).toHaveText('Only a name is needed.');
  await expect(seat1.getByTestId('card-more')).not.toHaveAttribute('open', '');
  await expect(seat1.getByTestId('write-card')).toBeVisible();

  // Step 3: write the card from a description with no pronouns, so the pronouns are only a suggestion.
  await seat1.setViewportSize({ width: 390, height: 844 });
  await seat1.getByTestId('card-description').fill('A clever archivist who hides a debt');
  await seat1.getByTestId('write-card').scrollIntoViewIfNeeded();
  await seat1.screenshot({ path: 'test-results/player-characters-pre-show-narrow.png' });
  await seat1.getByTestId('write-card').click();
  await expect(seat1.getByTestId('card-summary')).toBeVisible();
  await expect(seat1.getByTestId('card-pronouns-note')).toHaveText('The AI picked these pronouns. Change them if you like.');
  await expect(seat1.getByTestId('card-name')).not.toHaveValue('');
  await seat1.getByTestId('card-more').getByText('More about your character', { exact: true }).click();
  await expect(seat1.getByLabel('Pronouns', { exact: true })).toHaveValue('they/them');
  await expect(seat1.getByTestId('save-character-draft')).toBeEnabled();
  await seat1.screenshot({ path: 'test-results/player-characters-pre-show-written.png' });
  await seat1.getByTestId('save-character-draft').click();
  await expect(seat1.getByTestId('player-card').getByRole('heading', { level: 3 })).not.toHaveText('');
  await expect(seat1.getByTestId('change-my-card')).toBeVisible();

  // Step 4: the director sees seat 1 has a card at once, with nothing to approve. Seat 2 states pronouns, so no pronoun note appears.
  await expect(page.getByTestId(`waiting-for-card-${ids[0]}`)).toHaveCount(0);
  await expect(page.getByTestId(`waiting-for-card-${ids[1]}`)).toBeVisible();
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 1 of 2');
  const popup2 = context.waitForEvent('page');
  await page.getByRole('link', { name: /^Test as Seat 2/ }).click();
  const seat2 = await popup2;
  await expect(seat2.getByTestId('pre-show')).toBeVisible();
  await seat2.getByTestId('card-description').fill('A charming singer, she/her, who owes a debt');
  await seat2.getByTestId('write-card').click();
  await expect(seat2.getByTestId('card-summary')).toBeVisible();
  await expect(seat2.getByTestId('card-pronouns-note')).toHaveCount(0);
  await expect(seat2.getByTestId('card-name')).not.toHaveValue('');
  await seat2.getByTestId('card-more').getByText('More about your character', { exact: true }).click();
  await expect(seat2.getByLabel('Pronouns', { exact: true })).toHaveValue('she/her');
  await expect(seat2.getByTestId('save-character-draft')).toBeEnabled();
  await seat2.getByTestId('save-character-draft').click();

  // Step 5: every seat has a card, so the director can start. No approval, no pronoun check, no ready step.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 2 of 2');
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.screenshot({ path: 'test-results/player-characters-director-ready.png', fullPage: true });
  const final = await api(page, `/sessions/${sessionId}`);
  expect(final.characterDetails.every((character: { approved: boolean; draft?: unknown }) => character.approved && !character.draft)).toBe(true);
  expect(final.characterDetails.map((character: { pronouns: string }) => character.pronouns).sort()).toEqual(['she/her', 'they/them']);
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);
});
