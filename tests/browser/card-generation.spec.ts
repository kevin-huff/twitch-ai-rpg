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

test('writes whole cards with AI on a private link and in the Library editor', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  await page.getByTestId('library-link').click();
  const manager = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Invite players to build characters' }) });
  await expect(manager.locator('summary')).toBeVisible({ timeout: 2000 });
  await manager.locator('summary').click();
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
  await expect(player.getByRole('button', { name: /AI Generate/ })).toHaveCount(12, { timeout: 2000 });
  await expect(player.getByTestId('card-name')).toHaveValue('');
  const requests: Record<string, unknown>[] = [];
  player.on('request', request => { if (request.url().endsWith('/api/character-builder/generate-card')) requests.push(request.postDataJSON()); });

  await player.getByTestId('card-generator-open').click();
  await expect(player.getByTestId('card-generator-prompt')).toBeVisible();
  await expect(player.getByRole('button', { name: /AI Generate/ })).toHaveCount(12);
  await expect(player.getByTestId('card-generator-keep')).toHaveCount(0);
  await player.setViewportSize({ width: 390, height: 844 });
  await expectFieldHelp(player);
  await player.getByTestId('card-generator-prompt').scrollIntoViewIfNeeded();
  await player.screenshot({ path: 'test-results/card-generator-link-narrow.png' });
  await player.getByTestId('card-generator-prompt').fill('A strong he/him lighthouse keeper who fights storms');
  await player.getByTestId('card-generator-generate').click();
  await expect(player.getByTestId('card-generator-preview')).toContainText('Pronouns: he/him');
  await expect(player.getByTestId('card-generator-preview')).not.toContainText('suggested');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ prompt: 'A strong he/him lighthouse keeper who fights storms', keepFilled: false });
  await expect(player.getByTestId('card-name')).toHaveValue('');
  await player.screenshot({ path: 'test-results/card-generator-link-preview.png' });
  await player.getByTestId('card-generator-apply').click();
  await expect(player.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(player.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(player.getByTestId('card-name')).not.toHaveValue('');
  await expect(player.getByLabel('Pronouns', { exact: true })).toHaveValue('he/him');
  await expect(player.getByTestId('submit-builder-card')).toBeEnabled();
  expect((await api(player, '/character-builder')).draft.displayName).toBe('');

  await player.getByTestId('card-generator-undo').click();
  await expect(player.getByTestId('card-name')).toHaveValue('');
  await expect(player.getByLabel('Pronouns', { exact: true })).toHaveValue('');
  await expect(player.getByTestId('card-backstory')).toHaveValue('');
  await expect(player.getByTestId('card-generator-undo')).toHaveCount(0);

  await player.getByTestId('card-generator-open').click();
  await player.getByTestId('card-generator-prompt').fill('A strong he/him lighthouse keeper who fights storms');
  await player.getByTestId('card-generator-generate').click();
  await expect(player.getByTestId('card-generator-preview')).toBeVisible();
  await player.getByTestId('card-generator-apply').click();
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
  await page.getByTestId('card-generator-open').click();
  await expect(page.getByTestId('card-generator-keep')).toBeChecked();
  await page.getByTestId('card-generator-prompt').fill('A clever archivist who hides a debt');
  await page.getByTestId('card-generator-generate').click();
  await expect(page.getByTestId('card-generator-preview')).toContainText('Pronouns (suggested): they/them');
  await expect(page.getByTestId('card-generator-preview')).toContainText(`Name: ${typedName}`);
  await page.getByTestId('card-generator-apply').click();
  await expect(page.getByTestId('card-name')).toHaveValue(typedName);
  await expect(page.getByLabel('Pronouns', { exact: true })).toHaveValue('they/them');
  await expect(page.getByTestId('suggested-pronouns-notice')).toBeVisible();
  await expect(page.getByTestId('pronouns-pending-notice')).toBeVisible();
  await expect(page.getByTestId('save-character')).toBeDisabled();
  await page.getByTestId('save-character').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/card-generator-library-pending.png' });
  await page.getByTestId('keep-suggested-pronouns').click();
  await expect(page.getByTestId('suggested-pronouns-notice')).toHaveCount(0);
  await expect(page.getByTestId('pronouns-pending-notice')).toHaveCount(0);
  await expect(page.getByTestId('save-character')).toBeEnabled();
  await page.getByTestId('save-character').click();
  await expect.poll(async () => (await api(page, '/library')).characters.some((item: { definition: { displayName: string } }) => item.definition.displayName === typedName)).toBe(true);
  const saved = (await api(page, '/library')).characters.find((item: { definition: { displayName: string } }) => item.definition.displayName === typedName);
  expect(saved.definition.pronouns).toBe('they/them');
  expect(saved.definition.backstory).not.toBe('');
});
