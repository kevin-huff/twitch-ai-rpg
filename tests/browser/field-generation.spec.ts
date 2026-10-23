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

test('keeps field explanations visible and linked across scenario, character, and generation forms at narrow widths', async ({ page }) => {
  await page.goto('/');
  await expectFieldHelp(page);
  await page.getByLabel('Host access token', { exact: true }).fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByTestId('library-link').click();
  await page.getByRole('button', { name: 'Use rehearsal scenario', exact: true }).click();
  await expect(page.getByLabel('Premise', { exact: true })).not.toHaveValue('');
  await page.locator('details').evaluateAll(details => details.forEach(detail => detail.setAttribute('open', '')));
  for (const width of [1280, 650, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expectFieldHelp(page);
    await expect(page.getByLabel('Premise', { exact: true })).toHaveAccessibleDescription(/public.*AI/i);
  }
  await page.getByLabel('Premise', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/field-help-scenario-narrow.png' });
  await page.getByRole('button', { name: 'AI Generate Genre', exact: true }).click();
  await expectFieldHelp(page);
  await page.getByTestId('field-generator-source').selectOption('premise');
  await expectFieldHelp(page);
  await page.getByTestId('field-generator-hint').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/field-help-generator-narrow.png' });
  await page.getByRole('button', { name: 'Cancel generation for Genre', exact: true }).click();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await expectFieldHelp(page);
  await expect(page.getByLabel('Character name', { exact: true })).toHaveAccessibleDescription(/public/i);
  await expect(page.getByRole('combobox', { name: 'force', exact: true })).toHaveAccessibleDescription(/strength.*\+2, \+1, \+1, and \+0/i);
  await page.getByTestId('card-name').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/field-help-character-narrow.png' });
});

test('chooses an unsaved premise or a custom description and explicitly selects a premise for character cards', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, title: `Premise sources ${Date.now()}`, premise: 'An old railway crosses the kingdom.', directorNotes: 'PRIVATE-DO-NOT-SEND' } });
  await page.getByTestId('library-link').click();
  await page.getByTestId(`edit-scenario-${scenario.id}`).click();
  const premise = 'Ghost trains carry forgotten memories through a clockwork city.';
  await page.getByLabel('Premise', { exact: true }).fill(premise);
  const requests: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/authoring/generate-field')) requests.push(request.postDataJSON()); });
  await page.getByRole('button', { name: 'AI Generate Genre', exact: true }).click();
  await expect(page.getByTestId('field-generator-source')).toBeVisible({ timeout: 2000 });
  await expect(page.getByTestId('field-generator-source')).toHaveValue('description');
  await page.getByTestId('field-generator-source').selectOption('premise');
  await expect(page.getByTestId('field-generator-premise')).toHaveValue(premise);
  await expect(page.getByTestId('field-generator-hint')).toHaveValue('');
  await page.getByRole('button', { name: 'Generate Genre', exact: true }).click();
  await expect(page.getByTestId('field-generator-preview')).toBeVisible();
  const genre = (await page.getByTestId('field-generator-preview').textContent())!;
  await expect(page.getByLabel('Genre', { exact: true })).toHaveValue(starter.scenario.genre);
  const panelBounds = (await page.locator('.generator-panel').boundingBox())!;
  expect(panelBounds.y).toBeGreaterThanOrEqual(0);
  expect(panelBounds.y + panelBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: 'test-results/premise-generation-preview.png' });
  await page.getByRole('button', { name: 'Apply generated Genre', exact: true }).click();
  await expect(page.getByLabel('Genre', { exact: true })).toHaveValue(genre);
  expect((await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === scenario.id).definition.premise).toBe('An old railway crosses the kingdom.');
  expect(requests).toEqual([{ field: 'scenario.genre', seed: '', premise }]);

  await page.getByRole('button', { name: 'AI Generate Genre', exact: true }).click();
  await expect(page.getByTestId('field-generator-source')).toHaveValue('description');
  await page.getByTestId('field-generator-seed').fill('Gothic mystery');
  await page.getByRole('button', { name: 'Generate Genre', exact: true }).click();
  await expect(page.getByTestId('field-generator-preview')).toContainText('Gothic mystery');
  expect(requests[1]).toEqual({ field: 'scenario.genre', seed: 'Gothic mystery' });
  await page.getByRole('button', { name: 'Cancel generation for Genre', exact: true }).click();
  await expect(page.getByLabel('Genre', { exact: true })).toHaveValue(genre);
  await page.getByTestId('save-scenario').click();
  await expect.poll(async () => (await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === scenario.id).version).toBe(2);

  const card = await api(page, '/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[0] });
  await page.reload();
  await page.getByTestId(`edit-character-${card.id}`).click();
  await expect(page.getByTestId('character-premise-source')).toHaveValue('');
  await page.getByTestId('character-premise-source').selectOption(`${scenario.id}:2`);
  await page.getByRole('button', { name: 'AI Generate Backstory', exact: true }).click();
  await page.getByTestId('field-generator-source').selectOption('premise');
  await expect(page.getByTestId('field-generator-premise')).toHaveValue(premise);
  await page.getByTestId('field-generator-hint').fill('A station cartographer');
  await page.getByRole('button', { name: 'Generate Backstory', exact: true }).click();
  await expect(page.getByTestId('field-generator-preview')).toBeVisible();
  const { schemaVersion: _schemaVersion, extensions: _extensions, ...characterFields } = starter.characters[0];
  expect(requests[2]).toEqual({ field: 'character.backstory', seed: 'A station cartographer', premise, characterContext: { kind: 'character', ...characterFields } });
  await page.getByRole('button', { name: 'Apply generated Backstory', exact: true }).click();
  await expect(page.getByTestId('card-backstory')).not.toHaveValue(starter.characters[0].backstory);
  expect((await api(page, '/library')).characters.find((item: { id: string }) => item.id === card.id).definition.backstory).toBe(starter.characters[0].backstory);
  await page.reload();
  await page.getByTestId(`edit-scenario-${scenario.id}`).click();
  await expect(page.getByLabel('Premise', { exact: true })).toHaveValue(premise);
  await expect(page.getByLabel('Genre', { exact: true })).toHaveValue(genre);
});

test('drafts from unsaved fields of only the current non-player character or character card', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const definition = { ...starter.scenario, title: `Character context ${Date.now()}`, directorNotes: 'UNRELATED-DIRECTOR-NOTES', npcs: starter.scenario.npcs.map((npc: Record<string, unknown>, index: number) => ({ ...npc, displayName: index === 0 ? 'Context keeper' : `Other character ${index}`, secrets: [index === 0 ? 'OWN-NPC-SECRET' : 'UNRELATED-NPC-SECRET'] })) };
  const saved = await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition });
  const card = await api(page, '/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: { ...starter.characters[0], displayName: 'Context cartographer' } });
  await page.getByTestId('library-link').click();
  await page.getByTestId(`edit-scenario-${saved.id}`).click();
  await page.locator('summary').filter({ hasText: 'Non-player characters ·' }).click();
  const npc = page.locator('.editor-row').filter({ has: page.getByRole('heading', { name: 'Context keeper', exact: true }) });
  await npc.getByLabel('Role', { exact: true }).fill('Mapmaker aboard a stormship');
  await npc.getByLabel('Current goal', { exact: true }).fill('Recover a missing sky chart');
  await npc.getByLabel('Appearance', { exact: true }).fill('');
  const requests: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/authoring/generate-field')) requests.push(request.postDataJSON()); });
  await npc.getByRole('button', { name: 'AI Generate Appearance', exact: true }).click();
  await expect(npc.getByTestId('field-generator-seed')).toHaveValue('');
  await expect(npc.locator('.generator-panel')).toContainText('Context keeper');
  await expect(npc.locator('.generator-panel')).toContainText('private');
  await npc.getByRole('button', { name: 'Generate Appearance', exact: true }).click();
  await expect(npc.getByTestId('field-generator-preview')).toContainText('Mapmaker');
  const { id: _npcId, ...npcFields } = definition.npcs[0];
  expect(requests[0]).toEqual({ field: 'npc.appearance', seed: '', characterContext: { kind: 'npc', ...npcFields, role: 'Mapmaker aboard a stormship', goal: 'Recover a missing sky chart', appearance: '' } });
  expect(JSON.stringify(requests[0])).not.toMatch(/UNRELATED/);
  const generatedAppearance = (await npc.getByTestId('field-generator-preview').textContent())!;
  await npc.getByRole('button', { name: 'Apply generated Appearance', exact: true }).click();
  await expect(npc.getByLabel('Appearance', { exact: true })).toHaveValue(generatedAppearance);
  await expect(npc.getByLabel('Current goal', { exact: true })).toHaveValue('Recover a missing sky chart');
  expect((await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === saved.id).version).toBe(1);

  await page.getByTestId(`edit-character-${card.id}`).click();
  await page.getByTestId('card-appearance').fill('Ink-stained hands and a patched coat');
  await page.getByTestId('card-secret').fill('OWN-UNSAVED-CARD-SECRET');
  await page.getByTestId('card-backstory').fill('');
  await page.getByRole('button', { name: 'AI Generate Backstory', exact: true }).click();
  await page.getByRole('button', { name: 'Generate Backstory', exact: true }).click();
  await expect(page.getByTestId('field-generator-preview')).toContainText('Context cartographer');
  const { schemaVersion: _version, extensions: _extensionData, ...cardFields } = card.definition;
  expect(requests[1]).toEqual({ field: 'character.backstory', seed: '', characterContext: { kind: 'character', ...cardFields, appearance: 'Ink-stained hands and a patched coat', secret: 'OWN-UNSAVED-CARD-SECRET', backstory: '' } });
  expect(JSON.stringify(requests[1])).not.toMatch(/OWN-NPC-SECRET|UNRELATED/);
  const contextPanel = (await page.locator('.generator-panel').boundingBox())!;
  expect(contextPanel.y).toBeGreaterThanOrEqual(0);
  expect(contextPanel.y + contextPanel.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: 'test-results/character-context-preview.png' });
  const backstory = (await page.getByTestId('field-generator-preview').textContent())!;
  await page.getByRole('button', { name: 'Apply generated Backstory', exact: true }).click();
  await expect(page.getByTestId('card-backstory')).toHaveValue(backstory);
  await expect(page.getByTestId('card-secret')).toHaveValue('OWN-UNSAVED-CARD-SECRET');
  expect((await api(page, '/library')).characters.find((item: { id: string }) => item.id === card.id).definition.backstory).toBe(card.definition.backstory);
});

test('expands individual director fields as reviewed drafts before saving or changing the live world', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, title: `Field drafts ${Date.now()}`, directorNotes: 'PRIVATE-UNRELATED-DIRECTOR-NOTES' } });
  await page.getByTestId('library-link').click();
  await page.getByTestId(`edit-scenario-${scenario.id}`).click();
  const requests: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/authoring/generate-field')) requests.push(request.postDataJSON()); });
  await expect(page.getByRole('button', { name: 'AI Generate Premise', exact: true })).toBeVisible({ timeout: 2000 });
  await page.getByRole('button', { name: 'AI Generate Premise', exact: true }).click();
  await page.getByRole('textbox', { name: 'Description for Premise', exact: true }).fill('A lighthouse answers an impossible signal');
  await page.getByRole('button', { name: 'Generate Premise', exact: true }).click();
  const preview = page.getByTestId('field-generator-preview');
  await expect(preview).toContainText('A lighthouse answers an impossible signal');
  const expanded = (await preview.textContent())!;
  await page.screenshot({ path: 'test-results/field-generation-preview.png' });
  await expect(page.getByLabel('Premise', { exact: true })).toHaveValue(starter.scenario.premise);
  expect((await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === scenario.id).version).toBe(1);
  await page.getByRole('button', { name: 'Apply generated Premise', exact: true }).click();
  await expect(page.getByLabel('Premise', { exact: true })).toHaveValue(expanded);
  expect((await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === scenario.id).definition.premise).toBe(starter.scenario.premise);
  await page.screenshot({ path: 'test-results/field-generation-library.png', fullPage: true });
  await page.getByTestId('save-scenario').click();
  await expect.poll(async () => (await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === scenario.id).version).toBe(2);
  await page.reload();
  await page.getByTestId(`edit-scenario-${scenario.id}`).click();
  await expect(page.getByLabel('Premise', { exact: true })).toHaveValue(expanded);
  expect(requests).toEqual([{ field: 'scenario.premise', seed: 'A lighthouse answers an impossible signal' }]);

  const card = await api(page, '/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[0] });
  await page.reload();
  await page.getByTestId(`edit-character-${card.id}`).click();
  await page.setViewportSize({ width: 650, height: 900 });
  await page.getByRole('button', { name: 'AI Generate Character name', exact: true }).click();
  const nameSeed = page.getByRole('textbox', { name: 'Description for Character name', exact: true });
  await expect(nameSeed).toBeVisible();
  const seedBounds = (await nameSeed.boundingBox())!;
  expect(seedBounds.x).toBeGreaterThanOrEqual(0);
  expect(seedBounds.x + seedBounds.width).toBeLessThanOrEqual(650);
  await page.screenshot({ path: 'test-results/field-generation-narrow.png' });
  await page.getByRole('button', { name: 'Cancel generation for Character name', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });

  const show = await api(page, '/sessions', { commandId: crypto.randomUUID(), title: 'Generated fields rehearsal' });
  const identity = new URL(page.url()).searchParams.get('identity');
  const before = await api(page, `/sessions/${show.sessionId}`);
  await api(page, `/sessions/${show.sessionId}/commands`, { type: 'set_status', commandId: crypto.randomUUID(), expectedStateRevision: before.session.stateRevision, status: 'live' });
  await page.goto(`/sessions/${show.sessionId}/director?identity=${identity}`);
  const controls = page.getByTestId('live-controls');
  await controls.locator(':scope > summary').click();
  await controls.getByTestId('begin-scene').click();
  const original = await api(page, `/sessions/${show.sessionId}`);
  await controls.getByRole('button', { name: 'AI Generate Scene description', exact: true }).click();
  await controls.getByRole('textbox', { name: 'Description for Scene description', exact: true }).fill('Mist gathers around the harbor');
  await controls.getByRole('button', { name: 'Generate Scene description', exact: true }).click();
  await expect(controls.getByTestId('field-generator-preview')).toContainText('Mist gathers');
  const liveText = (await controls.getByTestId('field-generator-preview').textContent())!;
  await controls.getByRole('button', { name: 'Apply generated Scene description', exact: true }).click();
  await expect(controls.getByTestId('scene-description')).toHaveValue(liveText);
  expect((await api(page, `/sessions/${show.sessionId}`)).session).toEqual(original.session);
  await controls.getByTestId('live-reason').fill('Move into the fog.');
  await controls.getByTestId('discard-input').check();
  await controls.getByTestId('save-live').click();
  await expect.poll(async () => (await api(page, `/sessions/${show.sessionId}`)).session.scene.description).toBe(liveText);
  const grant = await api(page, `/sessions/${show.sessionId}/test-seat`, { characterId: original.characters[0].id });
  const player = await context.newPage();
  await player.goto(`/sessions/${show.sessionId}/lobby?identity=${grant.identityId}`);
  await expect(player.getByRole('heading', { name: 'Meet your accomplices.', exact: true })).toBeVisible();
  await expect(player.getByTestId('field-generator-open')).toHaveCount(0);
});
