import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, status = 200) {
  const result = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/api${path}`, { headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(status);
  return result.data;
}

test('a newcomer opens an invitation, joins with the card their host picked, and the page turns into the seat when the show starts', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('try-it-now')).toBeVisible();

  const title = `Newcomer show ${randomUUID().slice(0, 8)}`;
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, title: `Newcomer story ${randomUUID().slice(0, 8)}` } });
  const cards: Array<{ id: string; version: number }> = [];
  for (const [index, name] of ['Wren', 'Tarn'].entries()) {
    cards.push(await api(page, '/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.characters[index], displayName: `${name} ${randomUUID().slice(0, 4)}` } }));
  }
  const created = await api(page, '/sessions', {
    commandId: randomUUID(), title,
    scenario: { templateId: scenario.id, version: scenario.version },
    characters: cards.map(card => ({ templateId: card.id, version: card.version })),
  });
  const sessionId = created.sessionId as string;
  const { invites } = await api(page, `/sessions/${sessionId}/invites`);
  const seatOne = invites.find((row: { role: string; status: string }) => row.role === 'player' && row.status === 'waiting');
  const { token } = await api(page, `/sessions/${sessionId}/invites/${seatOne.id}/link`);

  const newcomerContext = await browser.newContext();
  try {
    const newcomer = await newcomerContext.newPage();

    await newcomer.goto('/join/not-a-real-token');
    await expect(newcomer.getByTestId('invite-error')).toHaveText('This invitation has already been used or has expired. Ask your host for a new link.');
    await expect(newcomer.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);

    await newcomer.goto(`/join/${token}`);
    await expect(newcomer.getByText(`You've been invited to play ${title}.`)).toBeVisible();
    await expect(newcomer.getByText('Press Join to take your seat.')).toBeVisible();
    await newcomer.getByRole('button', { name: 'Join', exact: true }).click();

    await expect(newcomer.getByRole('heading', { name: 'Your character' })).toBeVisible();
    await expect(newcomer.getByTestId('host-picked-note')).toHaveText('Your host picked this character for you.');
    await expect(newcomer.getByText('The show will start soon.')).toBeVisible();
    await expect(newcomer.getByTestId('submission-form')).toHaveCount(0);

    await page.goto(`/sessions/${sessionId}/director`);
    await page.getByTestId('setup-lobby-link').click();
    await expect(page.getByTestId('seats-with-card')).toContainText('2 of 2');
    await page.getByTestId('start-session').click();
    await expect(page.getByTestId('start-session')).toHaveCount(0);

    await expect(newcomer.getByTestId('submission-form')).toBeVisible();
    await expect(newcomer.getByTestId('pre-show')).toHaveCount(0);

    await page.goto(`/sessions/${sessionId}/director`);
    await expect(page.getByTestId('director-controls')).toBeVisible();
    const state = await api(page, `/sessions/${sessionId}?view=director`);
    await api(page, `/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });

    await expect(newcomer.locator('.player-status')).toContainText(/What does .* say\?/);
    await newcomer.getByTestId('speech-input').fill('Nobody told me this table had a rule about lanterns.');
    await newcomer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(newcomer.getByRole('status')).toContainText('Saved. The director has your line.');
  } finally { await newcomerContext.close(); }
});
