import { expect, test, type Page } from '@playwright/test';

function snapshotFor(page: Page, path: string) {
  const identity = new URL(page.url()).searchParams.get('identity');
  return page.request.get(path, { headers: identity ? { 'X-RPG-Identity': identity } : {} });
}

test('four players, two Mara exchanges, a reviewed dice action, stage and refresh', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  const invitations = await Promise.all([1, 2, 3, 4].map(index => page.getByLabel(`Player ${index} invitation`).inputValue()));
  const stageInvitation = await page.getByLabel('Stage invitation').inputValue();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = page.url().split('/sessions/')[1].split('/')[0];
  const contexts = await Promise.all(invitations.map(() => browser.newContext()));
  const players = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all(players.map(async (player, index) => {
      await player.goto(invitations[index]);
      await player.getByRole('button', { name: 'Join session' }).click();
      await expect(player.getByTestId('submission-form')).toBeVisible();
      await expect(player.locator('.header-meta .status')).toHaveText('Connected');
    }));
    const stageContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    contexts.push(stageContext);
    const stage = await stageContext.newPage();
    await stage.goto(stageInvitation);
    await stage.getByRole('button', { name: 'Join session' }).click();
    await expect(stage.locator('.stage')).toBeVisible();

    async function direct(kind: 'conversation' | 'action', selectedNames: string[]) {
      for (const name of selectedNames) await page.locator('.queue-item').filter({ has: page.getByText(name, { exact: true }) }).getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Plan selected input' }).click();
      await page.getByRole('button', { name: 'Approve stakes', exact: true }).click();
      await page.getByRole('button', { name: /Lock input/ }).click();
      await page.getByRole('button', { name: 'Draft the scene', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Publish text-only beat' })).toBeEnabled();
      if (kind === 'conversation') {
        const continuity = page.getByText(/Review \d+ proposed continuity updates/);
        if (await continuity.isVisible()) {
          await continuity.click();
          await page.getByRole('button', { name: 'Approve continuity updates' }).click();
        }
      }
      await page.getByRole('button', { name: 'Publish text-only beat' }).click();
    }
    async function say(player: Page, text: string) {
      await player.reload();
      await expect(player.getByTestId('submission-form')).toBeVisible();
      await player.getByTestId('speech-input').fill(text);
      await player.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(player.getByRole('status')).toContainText('Saved');
    }
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await say(players[0], 'You knew the previous owner. What happened to him?');
    await direct('conversation', ['Rook']);
    await expect(stage.locator('.stage-story')).toContainText('Why are you asking?');
    await expect(stage.locator('.stage-story')).toContainText('Mara Vale');
    await expect(stage.locator('.stage-story')).toContainText('You knew the previous owner. What happened to him?');
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await say(players[1], 'Because someone just offered to sell it to us.');
    await direct('conversation', ['Lark']);
    await expect(stage.locator('.stage-story')).toContainText('survive the paperwork');
    await stage.reload();
    await expect(stage.locator('.stage-story')).toContainText('survive the paperwork');
    await expect(stage.locator('body')).not.toContainText('archive safe');

    await page.getByRole('button', { name: 'Open action round' }).click();
    await Promise.all(players.map(async (player, index) => {
      await expect.poll(async () => (await snapshotFor(player, `/api/sessions/${sessionId}?view=player`)).json().then(data => data.activeBeat?.kind)).toBe('action');
      await player.reload();
      await player.getByRole('button', { name: 'Do something', exact: true }).click();
      await player.getByTestId('action-input').fill(['Lift the stuck service hatch with my gloves and a lever', 'Pick the archive lock with my lockpick', 'Inspect the records and compare the signatures', 'Distract Inspector Dax by discussing procedure'][index]);
      await player.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(player.getByRole('status')).toContainText('Saved');
    }));
    await direct('action', ['Rook', 'Lark', 'Quill', 'Pip']);
    await expect(stage.locator('.roll')).toHaveCount(4);
    const before = await (await snapshotFor(page, `/api/sessions/${sessionId}?view=director`)).json();
    expect(before.session).toMatchObject({ beatNumber: 3, actionRoundNumber: 1 });
    expect(before.npcDetails.find((npc: { displayName: string }) => npc.displayName === 'Mara Vale').knowledge.some((entry: { statement: string }) => entry.statement.includes('sale'))).toBe(true);
    const publicAsHost = await (await snapshotFor(page, `/api/sessions/${sessionId}?view=stage`)).json();
    expect(publicAsHost.role).toBe('stage');
    expect(publicAsHost).not.toHaveProperty('directorNotes');
    expect(publicAsHost).not.toHaveProperty('npcDetails');
    await page.reload();
    const after = await (await snapshotFor(page, `/api/sessions/${sessionId}?view=director`)).json();
    expect(after.history).toEqual(before.history);
    expect(after.tracks).toEqual(before.tracks);
    await stage.screenshot({ path: 'test-results/stage-rehearsal.png', fullPage: true });
    await page.screenshot({ path: 'test-results/director-rehearsal.png', fullPage: true });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
