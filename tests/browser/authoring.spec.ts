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

async function openMore(page: Page) {
  const more = page.getByTestId('beat-more');
  if (!(await more.evaluate(node => (node as HTMLDetailsElement).open))) await more.locator('summary').first().click();
}

test('authors a versioned show, approves two characters, and publishes their first exchange in one browser', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = {
    ...starter.scenario, title: 'The Signal', premise: 'Answer a remote station’s distress call.', genre: 'Science fiction', tone: 'Hopeful mystery',
    boundaries: ['No graphic injury'], directorNotes: 'PRIVATE-SIGNAL-NOTES', tracks: [],
    openingScene: { ...starter.scenario.openingScene, title: 'The Listening Post', description: 'A silent beacon flashes above the empty station.' },
    npcs: [{ ...starter.scenario.npcs[0], displayName: 'The Keeper', role: 'Station caretaker', appearance: 'A blue maintenance uniform.', voiceProfileId: 'voice_narrator', secrets: ['PRIVATE-KEEPER-SECRET'], knowledge: [], dialogueExamples: [] }],
    facts: [], objectives: ['Restore the beacon'], playerHooks: ['You answered the call'], discoveries: [], opportunities: [],
  };
  const savedScenario = await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: scenario });
  const cards: Array<{ id: string; version: number }> = [];
  for (const [index, name] of ['Nia', 'Oren'].entries()) cards.push(await api(page, '/library/characters', {
    commandId: crypto.randomUUID(), expectedVersion: 0,
    definition: { ...starter.characters[index], displayName: name, secret: `PRIVATE-CARD-${name}`, appearance: `${name} wears a flight suit.` },
  }));
  await page.getByTestId('library-link').click();
  await page.getByTestId(`edit-scenario-${savedScenario.id}`).click();
  await page.getByTestId('scenario-title').fill('The Distant Signal');
  await page.getByTestId('save-scenario').click();
  await expect.poll(async () => (await api(page, '/library')).scenarios.find((item: { id: string }) => item.id === savedScenario.id)?.version).toBe(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/authoring-library.png' });
  await page.getByTestId(`edit-character-${cards[0].id}`).click();
  await page.getByTestId('card-name').fill('Nia Vale');
  await page.getByTestId('save-character').click();
  await expect.poll(async () => (await api(page, '/library')).characters.find((item: { id: string }) => item.id === cards[0].id)?.version).toBe(2);
  await page.getByTestId('show-title').fill('Friday at the Listening Post');
  await page.getByTestId('show-scenario').selectOption(`${savedScenario.id}:2`);
  await page.getByTestId('show-seat-0').selectOption(`${cards[0].id}:2`);
  await page.getByTestId('show-seat-1').selectOption(`${cards[1].id}:1`);
  await page.getByTestId('create-custom').click();
  await page.waitForURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  let snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.setup.started).toBe(false);
  expect(snapshot.characterDetails.every((character: { approved: boolean; draft: unknown }) => character.approved && !character.draft)).toBe(true);
  const playerTabs: Page[] = [];
  for (const name of ['Nia Vale', 'Oren']) {
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: `Test as ${name}`, exact: true }).click();
    const player = await popup;
    playerTabs.push(player);
    await expect(player.getByTestId('pre-show')).toBeVisible();
  }
  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);
  const hostIdentity = new URL(page.url()).searchParams.get('identity');
  await page.goto(`/sessions/${sessionId}/director${hostIdentity ? `?identity=${hostIdentity}` : ''}`);
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await openMore(page);
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  const player = playerTabs[0]!;
  const playerIdentity = new URL(player.url()).searchParams.get('identity');
  await player.goto(`/sessions/${sessionId}/play?identity=${playerIdentity}`);
  await player.getByTestId('speech-input').fill('Who activated the beacon?');
  await player.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(player.getByRole('status')).toContainText('Saved');
  await expect(page.locator('.queue-item input[type=checkbox]').first()).toBeChecked();
  await page.getByTestId('plan-and-draft').click();
  await expect(page.getByTestId('publish-text-only')).toBeEnabled();
  await page.getByTestId('publish-text-only').click();
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).history.length).toBe(1);
  snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.history[0].segments.some((line: { kind: string; text: string }) => line.kind === 'player_dialogue' && line.text === 'Who activated the beacon?')).toBe(true);
  await api(page, '/library/scenarios', { commandId: crypto.randomUUID(), templateId: savedScenario.id, expectedVersion: 2, definition: { ...scenario, openingScene: { ...scenario.openingScene, title: 'Changed library scene' } } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The Listening Post', exact: true })).toBeVisible();
  const publicState = await api(page, `/sessions/${sessionId}?view=stage`);
  expect(JSON.stringify(publicState)).not.toMatch(/PRIVATE-|No graphic injury|draft|templateId/);
  expect(publicState.characters.map((character: { displayName: string }) => character.displayName)).toEqual(['Nia Vale', 'Oren']);
  await page.screenshot({ path: 'test-results/custom-show-director.png', fullPage: true });
});
