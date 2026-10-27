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


async function openFold(page: Page, testId: string) {
  const fold = page.getByTestId(testId);
  if (!(await fold.evaluate(details => (details as HTMLDetailsElement).open))) await fold.locator(':scope > summary').click();
}

test('directs recurring characters and deliberate reveals across scenes without rewriting the story', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  let snapshot = await api(page, `/sessions/${sessionId}`);
  await api(page, `/sessions/${sessionId}/commands`, { type: 'set_status', commandId: crypto.randomUUID(), expectedStateRevision: snapshot.session.stateRevision, status: 'live' });
  await page.reload();
  await openFold(page, 'show-tools');
  await expect(page.getByTestId('live-controls')).toBeVisible();
  const controls = page.getByTestId('live-controls');
  await controls.locator(':scope > summary').click();
  async function save(reason: string) {
    const before = (await api(page, `/sessions/${sessionId}`)).session.stateRevision;
    await controls.getByTestId('live-reason').fill(reason);
    await controls.getByTestId('discard-input').check();
    await controls.getByTestId('save-live').click();
    await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).session.stateRevision).toBe(before + 1);
    await expect(controls.getByTestId('save-live')).toHaveCount(0);
  }
  await controls.getByTestId('begin-npc').click();
  await controls.getByTestId('npc-name').fill('The Courier');
  await controls.getByTestId('npc-role').fill('Night messenger');
  await controls.getByText('Private characterization & secrets', { exact: true }).click();
  await controls.getByTestId('npc-identity').fill('PRIVATE: the missing heir');
  await controls.getByTestId('add-npc-secrets').click();
  await controls.getByTestId('npc-secrets-0').fill('PRIVATE: carries the key; reveal only after trust.');
  await save('Introduce a recurring messenger.');
  snapshot = await api(page, `/sessions/${sessionId}`);
  const courier = snapshot.npcDetails.find((npc: { displayName: string }) => npc.displayName === 'The Courier');
  const originalLocation = snapshot.session.scene.locationId;
  const playerGrant = await api(page, `/sessions/${sessionId}/test-seat`, { characterId: snapshot.characters[0].id });
  const player = await context.newPage();
  await player.goto(`/sessions/${sessionId}/play?identity=${playerGrant.identityId}`);
  const stage = await context.newPage();
  await stage.goto(`/sessions/${sessionId}/stage`);

  await controls.getByTestId('begin-reveal').click();
  await controls.getByTestId('reveal-npc').selectOption(courier.id);
  await controls.getByTestId('reveal-source').selectOption('secret:0');
  await expect(controls.getByTestId('reveal-text')).toHaveValue('');
  await controls.getByTestId('reveal-text').fill('The Courier carries the archive key.');
  await controls.getByTestId(`witness-${courier.id}`).check();
  await save('They have earned the clue.');
  for (const audience of [player, stage]) {
    if (audience === stage) await expect(audience.getByTestId('public-facts')).toContainText('The Courier carries the archive key.');
    else await expect(audience.getByTestId('public-facts')).toHaveCount(0);
    await expect(audience.locator('body')).not.toContainText('PRIVATE:');
    await expect(audience.locator('body')).not.toContainText('They have earned the clue.');
  }
  snapshot = await api(page, `/sessions/${sessionId}`);
  const memory = snapshot.npcDetails.find((npc: { id: string }) => npc.id === courier.id).knowledge;
  expect(memory).toHaveLength(1);

  await player.getByTestId('speech-input').fill('A question for the old scene.');
  await player.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(player.getByRole('status')).toContainText('Saved');
  await controls.getByTestId('begin-scene').click();
  await controls.getByTestId('scene-title').fill('Midnight on the platform');
  await controls.getByTestId('scene-description').fill('A train waits beneath the station clock.');
  await controls.getByTestId('scene-location-kind').selectOption('new');
  await controls.getByTestId('location-title').fill('Station platform');
  await controls.getByTestId('location-description').fill('PRIVATE: a hidden tunnel beneath the rails.');
  for (const npc of snapshot.npcDetails) await controls.getByTestId(`present-${npc.id}`).setChecked(npc.id === courier.id);
  await save('The cast follows the messenger.');
  await expect(player.getByRole('heading', { name: 'Midnight on the platform', exact: true })).toBeVisible();
  snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.submissions.find((input: { text: string }) => input.text === 'A question for the old scene.').status).toBe('cancelled');
  expect(snapshot.npcDetails.find((npc: { id: string }) => npc.id === courier.id)).toMatchObject({ id: courier.id, voiceProfileId: courier.voiceProfileId, knowledge: memory, status: 'present', locationId: snapshot.session.scene.locationId });
  expect(snapshot.npcDetails.filter((npc: { id: string }) => npc.id !== courier.id).every((npc: { status: string }) => npc.status === 'offstage')).toBe(true);
  const publicState = await api(page, `/sessions/${sessionId}?view=stage`);
  expect(publicState).not.toHaveProperty('locations');
  expect(JSON.stringify(publicState)).not.toContain('PRIVATE:');

  await controls.getByTestId('begin-scene').click();
  await controls.getByTestId('scene-title').fill('Return to the Ledger');
  await controls.getByTestId('scene-description').fill('The Courier returns to the bar with the cast.');
  await controls.getByTestId('scene-location').selectOption(originalLocation);
  await save('Return with a lead.');
  await controls.getByTestId('begin-npc').click();
  await controls.getByTestId('npc-choice').selectOption(courier.id);
  await controls.getByTestId('npc-name').fill('Courier Ren');
  await save('The messenger shares their public name.');
  await page.reload();
  snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.npcDetails.find((npc: { id: string }) => npc.id === courier.id)).toMatchObject({ displayName: 'Courier Ren', voiceProfileId: courier.voiceProfileId, knowledge: memory, locationId: originalLocation });
  await openFold(page, 'beat-more');
  await page.getByTestId('open-conversation').click();
  await expect(page.getByRole('heading', { name: 'Collecting input', exact: true })).toBeVisible();
  await player.reload();
  await expect(player.getByTestId('talking-to').or(player.getByLabel('Talking to'))).toBeVisible();
  if (await player.getByTestId('talking-to-change').count()) await player.getByTestId('talking-to-change').click();
  await player.getByLabel('Talking to').selectOption(courier.id);
  await player.getByTestId('speech-input').fill('Will you show us the key, Ren?');
  await player.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(player.getByRole('status')).toContainText('Saved');
  await expect(page.locator('.queue-item input[type=checkbox]')).toHaveCount(1);
  await expect(page.locator('.queue-item input[type=checkbox]')).toBeChecked();
  await page.getByTestId('plan-and-draft').click();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).history.length).toBe(1);
  snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.history[0].segments.some((segment: { kind: string; speaker?: { entityId: string } }) => segment.kind === 'npc_dialogue' && segment.speaker?.entityId === courier.id)).toBe(true);
  expect(snapshot.history[0].segments.some((segment: { kind: string; text: string }) => segment.kind === 'player_dialogue' && segment.text === 'Will you show us the key, Ren?')).toBe(true);
  const published = structuredClone(snapshot.history);
  async function update(value: Record<string, unknown>) {
    const result = await api(page, `/sessions/${sessionId}/commands`, { commandId: crypto.randomUUID(), expectedStateRevision: snapshot.session.stateRevision, discardQueuedInput: true, reason: 'A later director change.', ...value });
    snapshot = result.snapshot;
    expect(snapshot.history).toEqual(published);
  }
  await update({ type: 'change_scene', title: 'Closing time', description: 'The club grows quiet.', location: { kind: 'existing', locationId: originalLocation }, presentNpcIds: [courier.id] });
  const { id, version, knowledge, relationships, ...profile } = snapshot.npcDetails.find((npc: { id: string }) => npc.id === courier.id);
  await update({ type: 'save_npc', npcId: id, expectedNpcVersion: version, profile: { ...profile, displayName: 'Ren' } });
  await update({ type: 'reveal_npc', npcId: id, expectedNpcVersion: snapshot.npcDetails.find((npc: { id: string }) => npc.id === id).version, source: { kind: 'identity' }, publicText: 'Ren is the rightful heir.', witnessNpcIds: [id] });
  await stage.reload();
  await expect(stage.getByTestId('public-facts')).toContainText('The Courier carries the archive key.');
  await expect(stage.getByTestId('public-facts')).toContainText('Ren is the rightful heir.');
  await expect(stage.locator('body')).not.toContainText('PRIVATE:');
  await stage.screenshot({ path: 'test-results/live-stage.png', fullPage: true });
  await openFold(page, 'show-tools');
  await openFold(page, 'live-controls');
  await page.getByTestId('begin-reveal').click();
  await page.getByTestId('reveal-npc').selectOption(courier.id);
  await page.screenshot({ path: 'test-results/live-director-controls.png', fullPage: true });
});
