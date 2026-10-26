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

async function expectFieldHelp(page: Page) {
  const issues = await page.locator('input, textarea, select').evaluateAll(controls => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[id]')];
    return controls.filter(control => control.checkVisibility()).flatMap(control => {
      const label = control.getAttribute('aria-label') || control.getAttribute('data-testid') || control.closest('label')?.textContent || control.tagName;
      const ids = control.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
      if (!ids.length) return [`${label}: missing explanation`];
      return ids.flatMap(id => {
        const matches = nodes.filter(node => node.id === id);
        if (matches.length !== 1) return [`${label}: description ${id} is missing or duplicated`];
        const help = matches[0]!;
        const bounds = help.getBoundingClientRect();
        if (!help.checkVisibility() || !help.textContent?.trim() || help.closest('label')) return [`${label}: explanation is hidden, empty, or changes its label`];
        if (bounds.left < 0 || bounds.right > window.innerWidth + 1) return [`${label}: explanation extends beyond the window`];
        return [];
      });
    });
  });
  expect(issues).toEqual([]);
}

test('players write their own cards in the lobby, the director approves them, and the show can start', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: crypto.randomUUID(), expectedVersion: 0,
    definition: { ...starter.scenario, title: `Player cards ${Date.now()}`, boundaries: ['No graphic injury'] },
  });

  // Step 1: both seats default to a player-written card, and the director sees them waiting.
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
  await page.getByTestId('custom-lobby-link').click();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.setup.started).toBe(false);
  const ids: string[] = snapshot.characterDetails.map((character: { id: string }) => character.id);
  expect(ids).toHaveLength(2);
  for (const id of ids) await expect(page.getByTestId(`waiting-for-card-${id}`)).toHaveText("Waiting for this player's card");
  await expect(page.getByTestId('absent-player-hint')).toBeVisible();
  await expect(page.getByTestId('start-session')).toBeDisabled();

  // Step 2: seat 1 opens the empty form and sees the whole-card writer.
  const popup1 = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Test as Seat 1 ↗', exact: true }).click();
  const seat1 = await popup1;
  await seat1.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
  await expect(seat1.getByRole('heading', { name: 'Write your character', exact: true })).toBeVisible();
  await expect(seat1.getByTestId('write-character-guidance')).toBeVisible();
  await expect(seat1.getByTestId('card-name')).toHaveValue('');
  await expect(seat1.getByRole('button', { name: /AI Generate/ })).toHaveCount(12);
  await expect(seat1.getByRole('button', { name: 'Create the whole card with AI', exact: true })).toBeVisible();

  // Step 3: generate from a prompt with no pronouns, so the pronouns are only a suggestion.
  await seat1.getByTestId('card-generator-open').click();
  await seat1.setViewportSize({ width: 390, height: 844 });
  await expect(seat1.getByTestId('card-generator-prompt')).toBeVisible();
  await expectFieldHelp(seat1);
  await seat1.getByTestId('card-generator-prompt').scrollIntoViewIfNeeded();
  await seat1.screenshot({ path: 'test-results/player-characters-lobby-narrow.png' });
  await seat1.getByTestId('card-generator-prompt').fill('A clever archivist who hides a debt');
  await seat1.getByTestId('card-generator-generate').click();
  await expect(seat1.getByTestId('card-generator-preview')).toContainText('Pronouns (suggested): they/them');
  await expect(seat1.getByTestId('card-name')).toHaveValue('');
  await seat1.screenshot({ path: 'test-results/player-characters-lobby-preview.png' });
  await seat1.getByTestId('card-generator-apply').click();
  await expect(seat1.getByTestId('card-name')).not.toHaveValue('');
  await expect(seat1.getByLabel('Pronouns', { exact: true })).toHaveValue('they/them');
  await expect(seat1.getByTestId('suggested-pronouns-notice')).toBeVisible();
  await expect(seat1.getByTestId('pronouns-pending-notice')).toBeVisible();
  await expect(seat1.getByTestId('save-character-draft')).toBeDisabled();
  await seat1.getByTestId('save-character-draft').scrollIntoViewIfNeeded();
  await seat1.screenshot({ path: 'test-results/player-characters-lobby-pending.png' });
  await seat1.getByTestId('keep-suggested-pronouns').click();
  await expect(seat1.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(seat1.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(seat1.getByTestId('save-character-draft')).toBeEnabled();
  await seat1.getByTestId('save-character-draft').click();

  // Step 4: the director opens seat 2's tab and writes with stated pronouns, so nothing needs confirming.
  await expect(page.getByTestId(`waiting-for-card-${ids[0]}`)).toHaveCount(0);
  await expect(page.getByTestId(`waiting-for-card-${ids[1]}`)).toBeVisible();
  const popup2 = context.waitForEvent('page');
  await page.getByRole('link', { name: /^Test as Seat 2/ }).click();
  const seat2 = await popup2;
  await seat2.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
  await expect(seat2.getByRole('heading', { name: 'Write your character', exact: true })).toBeVisible();
  await seat2.getByTestId('card-generator-open').click();
  await seat2.getByTestId('card-generator-prompt').fill('A charming singer, she/her, who owes a debt');
  await seat2.getByTestId('card-generator-generate').click();
  await expect(seat2.getByTestId('card-generator-preview')).toContainText('Pronouns: she/her');
  await expect(seat2.getByTestId('card-generator-preview')).not.toContainText('suggested');
  await seat2.getByTestId('card-generator-apply').click();
  await expect(seat2.getByTestId('card-name')).not.toHaveValue('');
  await expect(seat2.getByLabel('Pronouns', { exact: true })).toHaveValue('she/her');
  await expect(seat2.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(seat2.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(seat2.getByTestId('save-character-draft')).toBeEnabled();
  await seat2.getByTestId('save-character-draft').click();

  // Step 5: the director approves both cards, both players accept the boundaries, and the show can start.
  await expect(page.getByTestId('absent-player-hint')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const id of ids) await page.getByTestId(`approve-character-${id}`).click();
  for (const player of [seat1, seat2]) {
    await expect(player.getByText('Your card is approved.', { exact: true })).toBeVisible();
    await player.getByTestId('accept-boundaries').check();
    await player.getByTestId('ready-character').click();
    await expect(player.getByText('You are ready for this version of the boundaries.', { exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.screenshot({ path: 'test-results/player-characters-director-ready.png', fullPage: true });
  const final = await api(page, `/sessions/${sessionId}`);
  expect(final.characterDetails.every((character: { approved: boolean; draft?: unknown }) => character.approved && !character.draft)).toBe(true);
  expect(final.characterDetails.map((character: { pronouns: string }) => character.pronouns).sort()).toEqual(['she/her', 'they/them']);
});
