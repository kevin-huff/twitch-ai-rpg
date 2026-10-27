import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

// The name and description boxes carry no help line of their own: the short card form keeps only the lines that say more than the label.
const LABEL_ONLY = ['card-name', 'card-description'];

async function openMore(page: Page) {
  const more = page.getByTestId('card-more');
  if (!(await more.evaluate(details => (details as HTMLDetailsElement).open))) await more.locator(':scope > summary').click();
}

async function expectFieldHelp(page: Page) {
  const issues = await page.locator('input, textarea, select').evaluateAll((controls, labelOnly) => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[id]')];
    return controls.filter(control => control.checkVisibility() && !labelOnly.includes(control.getAttribute('data-testid') ?? '')).flatMap(control => {
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
  }, LABEL_ONLY);
  expect(issues).toEqual([]);
}

test('writes whole cards with AI on a private link and in the Library editor', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  await page.getByTestId('library-link').click();
  const tools = page.getByTestId('advanced-tools');
  await tools.locator(':scope > summary').click();
  const manager = tools.locator('details').filter({ hasText: 'Invite players to build characters' });
  await expect(manager.locator(':scope > summary')).toBeVisible({ timeout: 2000 });
  await manager.locator(':scope > summary').click();
  const label = `Cora ${Date.now()}`;
  await page.getByTestId('builder-label').fill(label);
  await page.getByTestId('builder-instructions').fill('Build a lighthouse keeper.');
  await page.getByTestId('create-builder-link').click();
  const link = page.getByLabel(`Private character link for ${label}`, { exact: true });
  await expect(link).toBeVisible();
  const linkUrl = await link.inputValue();

  // Part 1: the private link page.
  const player = await context.newPage();
  await player.goto(linkUrl);
  await expect(player.getByTestId('card-name')).toBeVisible();
  await expect(player.getByTestId('card-name')).toHaveValue('');
  await expect(player.getByTestId('card-name-only')).toHaveText('Only a name is needed.');
  await expect(player.getByTestId('card-more')).not.toHaveAttribute('open', '');
  await expect(player.getByRole('button', { name: /AI Generate/ })).toHaveCount(1, { timeout: 2000 });
  const requests: Record<string, unknown>[] = [];
  player.on('request', request => { if (request.url().endsWith('/api/character-builder/generate-card')) requests.push(request.postDataJSON()); });

  await expect(player.getByTestId('write-card')).toBeDisabled();
  await expect(player.getByTestId('card-generator-undo')).toHaveCount(0);
  await player.setViewportSize({ width: 390, height: 844 });
  await expectFieldHelp(player);
  await player.getByTestId('card-description').scrollIntoViewIfNeeded();
  await player.screenshot({ path: 'test-results/card-generator-link-narrow.png' });
  await player.getByTestId('card-description').fill('A strong he/him lighthouse keeper who fights storms');
  await player.getByTestId('write-card').click();
  await expect(player.getByTestId('card-summary')).toBeVisible();
  await expect(player.getByTestId('card-summary')).toContainText('Name:');
  await expect(player.getByTestId('card-summary')).toContainText('Appearance:');
  await expect(player.getByTestId('card-summary')).toContainText('Personality:');
  await expect(player.getByTestId('card-pronouns-note')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ prompt: 'A strong he/him lighthouse keeper who fights storms', keepFilled: true });
  await expect(player.getByTestId('card-name')).not.toHaveValue('');
  await player.screenshot({ path: 'test-results/card-generator-link-preview.png' });
  await openMore(player);
  await expect(player.getByRole('button', { name: /AI Generate/ })).toHaveCount(12);
  await expect(player.getByLabel('Pronouns', { exact: true })).toHaveValue('he/him');
  await expect(player.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(player.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(player.getByTestId('submit-builder-card')).toBeEnabled();
  expect((await api(player, '/character-builder')).draft.displayName).toBe('');

  await player.getByTestId('card-generator-undo').click();
  await expect(player.getByTestId('card-name')).toHaveValue('');
  await expect(player.getByLabel('Pronouns', { exact: true })).toHaveValue('');
  await expect(player.getByTestId('card-backstory')).toHaveValue('');
  await expect(player.getByTestId('card-summary')).toHaveCount(0);
  await expect(player.getByTestId('card-generator-undo')).toHaveCount(0);

  await player.getByTestId('write-card').click();
  await expect(player.getByTestId('card-summary')).toBeVisible();
  await expect(player.getByTestId('card-name')).not.toHaveValue('');
  const name = await player.getByTestId('card-name').inputValue();
  expect(name).not.toBe('');
  await expect(player.getByRole('button', { name: /AI Generate/ })).toHaveCount(12);
  await player.getByTestId('submit-builder-card').scrollIntoViewIfNeeded();
  await player.getByRole('button', { name: 'Submit to director', exact: true }).click();
  await expect(player.getByRole('heading', { name: 'Submitted to the director' })).toBeVisible();
  const submitted = (await api(page, '/library')).characters.find((item: { definition: { displayName: string } }) => item.definition.displayName === name);
  expect(submitted).toBeTruthy();
  expect(submitted.definition.pronouns).toBe('he/him');
  expect(Object.values(submitted.definition.traits).sort()).toEqual([0, 1, 1, 2]);
  await player.close();

  // Part 2: the Library character editor.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await expect(page.getByTestId('card-name')).toHaveValue('');
  const typedName = `Typed Tamsin ${Date.now()}`;
  await page.getByTestId('card-name').fill(typedName);
  await page.getByTestId('card-description').fill('A clever archivist who hides a debt');
  await page.getByTestId('write-card').click();
  await expect(page.getByTestId('card-summary')).toContainText(`Name: ${typedName}`);
  await expect(page.getByTestId('card-name')).toHaveValue(typedName);
  await expect(page.getByTestId('card-pronouns-note')).toHaveText('The AI picked these pronouns. Change them if you like.');
  await openMore(page);
  await expect(page.getByLabel('Pronouns', { exact: true })).toHaveValue('they/them');
  await expect(page.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(page.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(page.getByTestId('save-character')).toBeEnabled();
  await page.getByTestId('save-character').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/card-generator-library-pending.png' });
  await page.getByTestId('save-character').click();
  await expect.poll(async () => (await api(page, '/library')).characters.some((item: { definition: { displayName: string } }) => item.definition.displayName === typedName)).toBe(true);
  const saved = (await api(page, '/library')).characters.find((item: { definition: { displayName: string } }) => item.definition.displayName === typedName);
  expect(saved.definition.pronouns).toBe('they/them');
  expect(saved.definition.backstory).not.toBe('');
});
