import { expect, test, type Page } from '@playwright/test';

const names = ['Rook', 'Lark', 'Quill', 'Pip'];
async function createTable(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByTestId('try-it-now').click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+\/director/);
  const sessionId = page.url().split('/sessions/')[1].split('/')[0];
  const { invites } = await (await page.request.get(`/api/sessions/${sessionId}/invites`)).json() as { invites: { id: string; role: string; status: string }[] };
  const links: string[] = [];
  for (const invite of invites.filter(row => row.status === 'waiting')) {
    const { token } = await (await page.request.get(`/api/sessions/${sessionId}/invites/${invite.id}/link`)).json() as { token: string };
    links.push(`${new URL(page.url()).origin}/join/${token}`);
  }
  const stageRow = invites.filter(row => row.status === 'waiting').findIndex(row => row.role === 'stage');
  const stageInvitation = links[stageRow];
  const playerInvitations = links.filter((_, index) => index !== stageRow);
  await expect(page.getByTestId('director-controls')).toBeVisible();
  return { invitations: playerInvitations, stageInvitation };
}

test('one browser keeps the director, four invited characters, and stage independent across refresh', async ({ page, context }) => {
  const { invitations, stageInvitation } = await createTable(page);
  const players: Page[] = [];
  for (const [index, invitation] of invitations.entries()) {
    const player = await context.newPage();
    players.push(player);
    await player.goto(invitation);
    await player.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(player.getByRole('heading', { name: names[index], exact: true })).toBeVisible();
  }
  const stage = await context.newPage();
  await stage.goto(stageInvitation);
  await stage.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(stage.locator('.stage')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await page.getByTestId('beat-more').locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await Promise.all(players.map(async (player, index) => {
    await player.reload();
    await expect(player.getByRole('heading', { name: names[index], exact: true })).toBeVisible();
    await expect(player.locator('.header-meta .status')).toHaveText('Connected');
    await player.getByTestId('speech-input').fill(`Independent words from ${names[index]}.`);
    await player.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(player.getByRole('status')).toContainText('Saved');
    const status = await player.evaluate(async () => (await fetch('/api/sessions', {
      headers: { 'X-RPG-Identity': new URL(location.href).searchParams.get('identity')! },
    })).status);
    expect(status).toBe(403);
  }));
  for (const name of names) {
    const input = page.locator('.queue-item').filter({ has: page.getByText(name, { exact: true }) });
    await expect(input).toContainText(`Independent words from ${name}.`);
  }
  await stage.reload();
  await expect(stage.locator('.stage')).toBeVisible();
  await expect(stage.getByTestId('director-controls')).toHaveCount(0);
  await expect(stage.getByTestId('submission-form')).toHaveCount(0);
});

test('director opens each test character in a new tab without using player invitations', async ({ page, context, browser }) => {
  const { invitations } = await createTable(page);
  const directorUrl = page.url();
  await page.getByRole('link', { name: 'Cast & lobby' }).click();
  await expect(page.getByRole('link', { name: 'Test as Rook ↗', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/multi-tab-lobby.png', fullPage: true });
  const playerTabs: Page[] = [];
  for (const name of names) {
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: `Test as ${name} ↗`, exact: true }).click();
    const player = await popup;
    playerTabs.push(player);
    await expect(player.getByRole('heading', { name, exact: true })).toBeVisible();
    expect(new URL(player.url()).searchParams.has('testCharacterId')).toBe(false);
    await expect(player.getByRole('link', { name: /^Test as / })).toHaveCount(0);
  }
  await page.goto(directorUrl);
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await Promise.all(playerTabs.map(async (player, index) => {
    await player.reload();
    await expect(player.getByRole('heading', { name: names[index], exact: true })).toBeVisible();
  }));
  const separatePlayer = await browser.newContext();
  try {
    const realPlayer = await separatePlayer.newPage();
    await realPlayer.goto(invitations[0]);
    await realPlayer.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(realPlayer.getByRole('heading', { name: 'Rook', exact: true })).toBeVisible();
  } finally { await separatePlayer.close(); }
});
