import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  const response = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const result = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json() };
  }, { path, body });
  expect(response.status, JSON.stringify(response.data)).toBe(200);
  return response.data;
}


async function openFold(page: Page, testId: string) {
  const fold = page.getByTestId(testId);
  if (!(await fold.evaluate(details => (details as HTMLDetailsElement).open))) await fold.locator(':scope > summary').click();
}

test('steers a locked scene without rerolling and publishes a correction to an older beat', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const id = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${id}`;
  let snapshot = await api(page, path);
  async function command(value: Record<string, unknown>) {
    snapshot = (await api(page, `${path}/commands`, { commandId: crypto.randomUUID(), ...value })).snapshot;
    return snapshot;
  }
  const beatCommand = (value: Record<string, unknown>) => command({ beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, ...value });
  await command({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  const mara = snapshot.npcDetails.find((npc: { displayName: string }) => npc.displayName === 'Mara Vale');
  await command({ type: 'reveal_npc', npcId: mara.id, expectedNpcVersion: mara.version, source: { kind: 'secret', index: 0 }, publicText: 'Mara carries the red archive key.', witnessNpcIds: [mara.id], reason: 'PRIVATE original reveal reason', discardQueuedInput: true, expectedStateRevision: snapshot.session.stateRevision });
  const fact = snapshot.facts.find((fact: { text: string }) => fact.text === 'Mara carries the red archive key.');
  const grant = await api(page, `${path}/test-seat`, { characterId: snapshot.characters[0].id });
  const player = await context.newPage();
  await player.goto(`${path}/play?identity=${grant.identityId}`);
  const stage = await context.newPage();
  await stage.goto(`${path}/stage`);
  await page.reload();
  await page.getByTestId('open-action').click();
  await expect(page.getByRole('heading', { name: 'Collecting input', exact: true })).toBeVisible();
  await player.reload();
  await player.getByRole('button', { name: 'Do something', exact: true }).click();
  await player.getByTestId('action-input').fill('Find the archive entrance by reading the map on the club wall');
  await player.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.queue-item input[type=checkbox]')).toHaveCount(1);
  await expect(page.locator('.queue-item input[type=checkbox]')).toBeChecked();
  await page.getByTestId('plan').click();
  await page.getByTestId('approve-and-roll').click();
  await expect(page.getByTestId('publish')).toBeVisible();
  snapshot = await api(page, path);
  const locked = structuredClone(snapshot.activeBeat);
  expect(locked.resolution.rolls).toHaveLength(1);
  await openFold(page, 'show-tools');
  const steering = page.getByTestId('beat-steering');
  await steering.locator(':scope > summary').click();
  await steering.getByTestId('beat-steering-text').fill('PRIVATE direction: keep Mara cautious and the pace quiet.');
  await steering.screenshot({ path: 'test-results/director-private-direction.png' });
  await steering.getByTestId('save-beat-steering').click();
  await expect(page.getByRole('heading', { name: 'Locked · dice fixed', exact: true })).toBeVisible();
  await expect(page.getByTestId('publish')).toHaveCount(0);
  snapshot = await api(page, path);
  for (const key of ['resolution', 'contracts', 'inputSnapshotHash', 'lockedSubmissions', 'sourceStateRevision']) expect(snapshot.activeBeat[key]).toEqual(locked[key]);
  for (const audience of [player, stage]) {
    const visible = await api(audience, `${path}${audience === stage ? '?view=stage' : ''}`);
    expect(JSON.stringify(visible)).not.toContain('PRIVATE');
    expect(visible.activeBeat).not.toHaveProperty('steering');
    await expect(audience.getByTestId('beat-steering')).toHaveCount(0);
  }
  await page.getByTestId('render').click();
  await page.getByTestId('publish').click();
  await expect.poll(async () => (await api(page, path)).history.length).toBe(1);
  snapshot = await api(page, path);
  const first = structuredClone(snapshot.history[0]);
  expect(first.rolls).toEqual(locked.resolution.rolls);

  // Move the target outside the stage transcript window.
  for (let index = 0; index < 3; index++) {
    await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    expect(snapshot.activeBeat.steering).toBe('');
    const line = `Follow-up question ${index + 1}.`;
    const submitted = (await api(player, `${path}/commands`, { type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text: line, recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true })).snapshot;
    const input = submitted.submissions.find((input: { text: string }) => input.text === line);
    await beatCommand({ type: 'plan_beat', submissionIds: [input.id] });
    await beatCommand({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
    await beatCommand({ type: 'lock_beat' });
    await beatCommand({ type: 'render_beat' });
    await beatCommand({ type: 'publish_beat', expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: true });
  }
  const history = structuredClone(snapshot.history);
  const counters = { beat: snapshot.session.beatNumber, round: snapshot.session.actionRoundNumber, epoch: snapshot.session.inputEpoch, revision: snapshot.session.stateRevision };
  await api(player, `${path}/commands`, { type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: null, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text: 'Pending words for the old facts.', recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true });
  await page.reload();
  await page.setViewportSize({ width: 430, height: 900 });
  await openFold(page, 'show-tools');
  const correction = page.getByTestId('correction-controls');
  await correction.locator(':scope > summary').click();
  await correction.getByTestId('begin-correction').click();
  await correction.getByTestId('correction-beat').selectOption(first.id);
  await correction.getByTestId('correction-public-text').fill('Correction to beat 1: the archive key is blue. Rook has 1 strain and the buyer timer is complete.');
  await correction.getByTestId('correction-reason').fill('PRIVATE continuity repair after checking our notes.');
  await correction.getByTestId('add-correction-fact').click();
  await correction.getByTestId('correction-target-0').selectOption(fact.id);
  await correction.getByTestId('correction-fact-text-0').fill('Mara carries the blue archive key.');
  await correction.getByTestId('correction-knowledge-0-0').selectOption('retain_belief');
  await correction.getByTestId('add-correction-strain').click();
  await correction.getByTestId('correction-value-1').fill('1');
  await correction.getByTestId('add-correction-track').click();
  const timer = snapshot.tracks.find((track: { kind: string }) => track.kind === 'countdown');
  await correction.getByTestId('correction-target-2').selectOption(timer.id);
  await correction.getByTestId('correction-value-2').fill(String(timer.max));
  await correction.getByTestId('correction-discard-input').check();
  await expect(correction.getByTestId('correction-public-preview')).not.toContainText('PRIVATE');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await correction.screenshot({ path: 'test-results/director-correction-form.png' });
  await correction.getByTestId('save-correction').click();
  await expect(correction.getByRole('status')).toContainText('Correction published');
  snapshot = await api(page, path);
  expect(snapshot.history).toEqual(history);
  expect(snapshot.session).toMatchObject({ beatNumber: counters.beat, actionRoundNumber: counters.round, stateRevision: counters.revision + 1, inputEpoch: counters.epoch + 1 });
  expect(snapshot.characters[0].strain).toBe(1);
  expect(snapshot.tracks.find((track: { id: string }) => track.id === timer.id).current).toBe(timer.max);
  expect(snapshot.facts.find((item: { id: string }) => item.id === fact.id).text).toBe('Mara carries the blue archive key.');
  expect(snapshot.npcDetails.find((npc: { id: string }) => npc.id === mara.id).knowledge).toContainEqual(expect.objectContaining({ statement: 'Mara carries the red archive key.', category: 'belief' }));
  expect(snapshot.submissions.find((input: { text: string }) => input.text === 'Pending words for the old facts.').status).toBe('cancelled');
  for (const audience of [player, stage]) {
    await audience.reload();
    if (audience === stage) {
      await expect(audience.getByTestId('published-correction')).toContainText('Correction to beat 1: the archive key is blue.');
      await expect(audience.getByTestId('public-facts')).toContainText('Mara carries the blue archive key.');
    } else {
      await expect(audience.getByTestId('submission-form')).toBeVisible();
      await expect(audience.getByTestId('published-correction')).toHaveCount(0);
      await expect(audience.getByTestId('public-facts')).toHaveCount(0);
    }
    await expect(audience.locator('body')).not.toContainText('PRIVATE');
    const visible = await api(audience, `${path}${audience === stage ? '?view=stage' : ''}`);
    expect(JSON.stringify(visible)).not.toContain('PRIVATE');
    expect(Object.keys(visible.corrections[0]).sort()).toEqual(['id', 'publishedBeatId', 'beatNumber', 'stateRevision', 'recordedAt', 'publicText'].sort());
  }
  await stage.screenshot({ path: 'test-results/director-correction-stage.png', fullPage: true });
});
