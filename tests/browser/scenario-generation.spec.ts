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

const SUGGESTION = 'Keep serious injuries off screen.';

test('writes a whole scenario with AI, loads it as an unsaved draft, saves it with the AI-added boundaries, and makes a show that waits for player-written cards', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  await page.getByTestId('library-link').click();

  // Step 1: the generator opens with a prompt box and a size that defaults to medium, and every control has linked help.
  await page.getByRole('button', { name: 'New scenario', exact: true }).click();
  await expect(page.getByText('New template', { exact: true })).toBeVisible();
  await page.getByTestId('scenario-generator-open').click();
  await expect(page.getByRole('button', { name: 'Create the whole scenario with AI', exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Describe your story/)).toBeVisible();
  await expect(page.getByLabel(/^Size/)).toBeVisible();
  await expect(page.getByTestId('scenario-generator-size')).toHaveValue('medium');
  await expect(page.getByTestId('scenario-generator-size').locator('option')).toHaveText(['Small', 'Medium', 'Large']);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFieldHelp(page);
  await page.getByTestId('scenario-generator-prompt').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/scenario-generator-narrow.png' });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Step 2: a large story is written in the background and previewed, with nothing in the editor yet.
  const requests: Record<string, unknown>[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/authoring/scenario-drafts')) requests.push(request.postDataJSON()); });
  await page.getByTestId('scenario-generator-size').selectOption('large');
  await page.getByTestId('scenario-generator-prompt').fill('A foggy harbor town where the lighthouse keeper has vanished');
  await page.getByTestId('scenario-generator-generate').click();
  await expect(page.getByTestId('scenario-generator-status')).toContainText('The AI is writing your story. This can take up to 6 minutes.');
  const preview = page.getByTestId('scenario-generator-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('3 places');
  await expect(preview).toContainText('2 characters');
  await expect(preview.getByRole('heading', { name: 'Suggested boundaries', exact: true })).toBeVisible();
  await expect(preview).toContainText(SUGGESTION);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ prompt: 'A foggy harbor town where the lighthouse keeper has vanished', size: 'large', boundaries: [] });
  await expect(page.getByTestId('scenario-title')).toHaveValue('New scenario');
  await expect(page.getByTestId('scenario-generator-apply')).toHaveText('Load into the editor');
  await page.getByTestId('scenario-generator-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/scenario-generator-preview.png' });

  // Step 3: loading makes a new unsaved template; the AI's boundaries sit in the box with a note, and saving is never blocked.
  await page.getByTestId('scenario-generator-apply').click();
  await expect(page.getByTestId('scenario-generator-preview')).toHaveCount(0);
  await expect(page.getByText('New template', { exact: true })).toBeVisible();
  await expect(page.getByText('Loaded the AI draft as a new unsaved scenario. Check every field, then press Save scenario version. Portraits for its characters are being made now.', { exact: true })).toBeVisible();
  // Portraits are made automatically after loading; saving waits until they have all landed, so none arrives afterwards and marks the saved editor as changed.
  await expect(page.getByTestId('create-all-portraits-status')).toHaveText('Made 2 portraits.');
  const title = await page.getByTestId('scenario-title').inputValue();
  expect(title).not.toBe('');
  expect(title).not.toBe('New scenario');
  await expect(page.getByTestId('boundaries-ai-note')).toHaveText('Added by the AI. Edit freely.');
  await expect(page.getByTestId('scenario-boundaries')).toHaveValue(new RegExp(SUGGESTION.replace(/\./g, '\\.')));
  await expect(page.getByTestId('suggested-boundaries-notice')).toHaveCount(0);
  await expect(page.getByTestId('suggested-boundaries-save-notice')).toHaveCount(0);
  await expect(page.getByTestId('save-scenario')).toBeEnabled();
  await page.getByTestId('boundaries-ai-note').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/scenario-generator-loaded.png' });

  // Step 4: saving stores the generated places and the AI-added boundaries.
  await page.getByTestId('save-scenario').click();
  await expect(page.getByText('Editing version 1', { exact: true })).toBeVisible();
  const library = await api(page, '/library');
  const saved = library.scenarios.find((item: { definition: { title: string } }) => item.definition.title === title);
  expect(saved).toBeTruthy();
  expect(saved.definition.locations).toHaveLength(3);
  expect(saved.definition.npcs).toHaveLength(2);
  expect(saved.definition.boundaries).toContain(SUGGESTION);

  // Step 5: generating again over an edited editor warns before replacing it, and Cancel leaves the editor alone.
  const edited = `${title} edited`;
  await page.getByTestId('scenario-title').fill(edited);
  await page.getByTestId('scenario-generator-open').click();
  await page.getByTestId('scenario-generator-prompt').fill('A quiet mountain monastery under siege');
  await page.getByTestId('scenario-generator-generate').click();
  await expect(page.getByTestId('scenario-generator-preview')).toBeVisible();
  await expect(page.getByTestId('scenario-generator-apply')).toHaveText('Replace the editor with this draft');
  await expect(page.getByText('This replaces your unsaved changes in the editor.', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.boundaries).toContain(SUGGESTION);
  await page.getByTestId('scenario-generator-cancel').click();
  await expect(page.getByTestId('scenario-generator-preview')).toHaveCount(0);
  await expect(page.getByTestId('scenario-title')).toHaveValue(edited);
  await page.screenshot({ path: 'test-results/scenario-generator-replace.png' });

  // Step 6: a custom show made from the saved scenario defaults every seat to a player-written card, lands on Cast & lobby, and shows the premise.
  await page.getByTestId('show-title').fill('Harbor night');
  await page.getByTestId('show-scenario').selectOption(`${saved.id}:${saved.version}`);
  for (const index of [0, 1]) await expect(page.getByTestId(`show-seat-${index}`)).toHaveValue('player');
  await page.getByTestId('create-custom').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/lobby/);
  await expect(page.getByTestId('ready-strip')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.setup.started).toBe(false);
  expect(snapshot.characterDetails).toHaveLength(2);
  expect(saved.definition.premise).not.toBe('');
  await expect(page.getByText(saved.definition.premise, { exact: true }).first()).toBeVisible();
  for (const character of snapshot.characterDetails as { id: string }[]) await expect(page.getByTestId(`waiting-for-card-${character.id}`)).toBeVisible();
  await expect(page.getByTestId('start-session')).toBeDisabled();
  await page.screenshot({ path: 'test-results/scenario-generator-lobby.png', fullPage: true });
});
