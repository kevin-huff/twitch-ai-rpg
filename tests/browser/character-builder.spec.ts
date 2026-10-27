import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, status = 200) {
  const result = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(status);
  return result.data;
}

async function openMore(page: Page) {
  const more = page.getByTestId('card-more');
  if (!(await more.evaluate(details => (details as HTMLDetailsElement).open))) await more.locator(':scope > summary').click();
}

async function openBuilderInvites(page: Page) {
  const tools = page.getByTestId('advanced-tools');
  await tools.locator(':scope > summary').click();
  const manager = tools.locator('details').filter({ hasText: 'Invite players to build characters' });
  await expect(manager.locator(':scope > summary')).toBeVisible({ timeout: 2000 });
  await manager.locator(':scope > summary').click();
  return manager;
}

test('players build private characters before a show, return later, and submit for director casting in one browser', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const hostIdentity = new URL(page.url()).searchParams.get('identity');
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.scenario });
  const otherCard = await api(page, '/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[1] });
  await page.getByTestId('library-link').click();
  const manager = await openBuilderInvites(page);
  const labels = [`Avery ${Date.now()}`, `Briar ${Date.now()}`];
  const links: string[] = [];
  for (const [index, label] of labels.entries()) {
    await page.getByTestId('builder-label').fill(label);
    await page.getByTestId('builder-instructions').fill(index === 0 ? 'Build a desert courier.' : 'Build a harbor guide.');
    await page.getByTestId('create-builder-link').click();
    const link = page.getByLabel(`Private character link for ${label}`, { exact: true });
    await expect(link).toBeVisible();
    links.push(await link.inputValue());
    expect(links[index]).not.toContain('identity=');
  }
  await manager.locator(':scope > summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/player-builder-invitations.png' });
  const [avery, briar] = await Promise.all([context.newPage(), context.newPage()]);
  await avery.goto(links[0]!);
  await expect(avery.getByTestId('card-name')).toBeVisible();
  await expect(avery).toHaveURL(/\/build-character\?identity=[a-f0-9]{32}$/);
  await expect(avery.locator('a.brand')).toHaveCount(0);
  await openMore(avery);
  await expect(avery.getByRole('button', { name: /AI Generate/ })).toHaveCount(12, { timeout: 2000 });
  await expect(avery.locator('.builder-instructions')).toHaveText('Build a desert courier.');
  await avery.screenshot({ path: 'test-results/player-builder-desktop.png' });
  await avery.getByRole('button', { name: 'AI Generate Backstory', exact: true }).click();
  await expect(avery.locator('.generator-panel')).toContainText(/director/i);
  await avery.getByTestId('field-generator-generate').click();
  const generatedBackstory = avery.getByTestId('field-generator-preview');
  await expect(generatedBackstory).toContainText('desert courier');
  const proposedBackstory = await generatedBackstory.innerText();
  expect((await api(avery, '/character-builder')).draft.backstory).toBe('');
  await expect(avery.getByTestId('card-backstory')).toHaveValue('');
  await avery.getByTestId('field-generator-apply').click();
  await expect(avery.getByTestId('card-backstory')).toHaveValue(proposedBackstory);
  expect((await api(avery, '/character-builder')).draft.backstory).toBe('');
  await avery.getByTestId('card-secret').fill('Avery private saved draft');
  await avery.getByTestId('card-trait-finesse').selectOption('2');
  await avery.getByTestId('save-builder-draft').click();
  await expect(avery.getByRole('status')).toContainText('Progress saved');
  await avery.reload();
  await expect(avery.getByTestId('card-name')).toHaveValue('');
  await expect(avery.getByTestId('card-secret')).toHaveValue('Avery private saved draft');
  await expect(avery.getByTestId('card-backstory')).toHaveValue(proposedBackstory);
  await expect(avery.getByTestId('card-trait-finesse')).toHaveValue('2');
  await api(avery, '/library', undefined, 401);

  await briar.goto(links[1]!);
  await expect(briar.getByTestId('card-name')).toBeVisible();
  await briar.getByTestId('card-name').fill('Briar unfinished character');
  await openMore(briar);
  await briar.getByTestId('card-secret').fill('Briar private draft');
  await briar.getByTestId('save-builder-draft').click();
  await expect(briar.getByRole('status')).toContainText('Progress saved');
  expect((await api(briar, '/character-builder')).draft.secret).toBe('Briar private draft');
  expect((await api(avery, '/character-builder')).draft.secret).toBe('Avery private saved draft');
  expect(new URL(page.url()).searchParams.get('identity')).toBe(hostIdentity);
  const summaries = await api(page, '/character-builders');
  expect(JSON.stringify(summaries)).not.toMatch(/Avery private saved draft|Briar private draft/);
  expect(JSON.stringify(await api(page, '/library'))).not.toContain('Avery private saved draft');

  const returning = await context.newPage();
  await returning.goto(links[0]!);
  await expect(returning.getByTestId('card-secret')).toHaveValue('Avery private saved draft');
  await returning.close();
  await avery.getByTestId('card-name').fill('Aster built by player');
  await openMore(avery);
  await avery.getByTestId('card-secret').fill('Avery unsaved private detail');
  await avery.getByRole('button', { name: 'AI Generate Character personality', exact: true }).click();
  await avery.getByTestId('field-generator-seed').fill('A patient courier');
  const generationRequest = avery.waitForRequest(request => request.url().endsWith('/api/character-builder/generate-field'));
  await avery.getByTestId('field-generator-generate').click();
  const request = await generationRequest;
  const body = request.postDataJSON();
  expect(body).toMatchObject({ expectedRevision: 1, field: 'character.personality', seed: 'A patient courier', characterContext: { kind: 'character', displayName: 'Aster built by player', secret: 'Avery unsaved private detail' } });
  expect(body).not.toHaveProperty('instructions');
  expect(body).not.toHaveProperty('premise');
  expect(JSON.stringify(body)).not.toContain('Briar');
  expect(request.headers()['x-rpg-identity']).toBe(new URL(avery.url()).searchParams.get('identity'));
  await expect(avery.getByTestId('field-generator-preview')).toBeVisible();
  await avery.setViewportSize({ width: 390, height: 844 });
  const panel = await avery.locator('.generator-panel').boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(844);
  await avery.screenshot({ path: 'test-results/player-builder-ai-narrow.png' });
  await avery.getByTestId('field-generator-apply').click();
  expect((await api(avery, '/character-builder')).draft.personality).toBe('');
  await api(avery, '/authoring/generate-field', { field: 'scenario.premise', seed: 'A story' }, 401);
  await avery.getByTestId('card-trait-finesse').selectOption('1');
  await avery.getByTestId('card-backstory').fill('The player wrote this immediately before submission.');
  await avery.getByTestId('card-secret').fill('Final secret submitted only to the director');
  await avery.setViewportSize({ width: 390, height: 844 });
  await avery.getByTestId('submit-builder-card').scrollIntoViewIfNeeded();
  await avery.screenshot({ path: 'test-results/player-builder-narrow.png' });
  await avery.getByTestId('submit-builder-card').click();
  await expect(avery.getByRole('heading', { name: 'Submitted to the director' })).toBeVisible();
  await expect(avery.getByTestId('card-name')).toBeDisabled();
  await expect(avery.getByRole('button', { name: /AI Generate/ })).toHaveCount(0);
  await avery.reload();
  await expect(avery.getByTestId('card-name')).toBeDisabled();
  await expect(avery.getByTestId('card-secret')).toHaveValue('Final secret submitted only to the director');
  await page.getByTestId('refresh-builder-submissions').click();
  const library = await api(page, '/library');
  const submitted = library.characters.find((item: { definition: { displayName: string } }) => item.definition.displayName === 'Aster built by player');
  expect(submitted.definition.backstory).toBe('The player wrote this immediately before submission.');
  expect(submitted.definition.secret).toBe('Final secret submitted only to the director');
  await expect(page.getByTestId(`edit-character-${submitted.id}`)).toBeVisible();
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:${scenario.version}`);
  await page.getByTestId('show-seat-0').selectOption(`${submitted.id}:${submitted.version}`);
  await page.getByTestId('show-seat-1').selectOption(`${otherCard.id}:${otherCard.version}`);
  await page.getByTestId('create-custom').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const session = await api(page, `/sessions/${sessionId}`);
  expect(session.setup.started).toBe(false);
  // A saved card picked for a seat counts as approved when the show is made.
  expect(session.characterDetails.every((character: { approved: boolean; draft: unknown }) => character.approved && !character.draft)).toBe(true);
  await page.goto('/library');
  await openBuilderInvites(page);
  await page.getByRole('button', { name: `Turn off link for ${labels[1]}`, exact: true }).click();
  await briar.reload();
  await expect(briar.getByRole('alert')).toContainText('expired, revoked, or unavailable');
  await expect(briar.getByTestId('save-builder-draft')).toHaveCount(0);
  await avery.close(); await briar.close();
});
