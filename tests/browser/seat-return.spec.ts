import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const USED = 'This invitation has already been used or has expired. Ask your host for a new link.';
const UNREACHABLE = 'Could not reach the show. Check your connection and try again.';

async function api(page: Page, path: string, body?: unknown, status = 200) {
  const result = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/api${path}`, { headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(status);
  return result.data;
}

test.setTimeout(120000);

test('a seat comes back in the same browser with its words, a failed send keeps them, and another browser needs a new link', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('try-it-now')).toBeVisible();

  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, title: `Return story ${randomUUID().slice(0, 8)}` } });
  const cards: Array<{ id: string; version: number }> = [];
  for (const [index, name] of ['Wren', 'Tarn'].entries()) {
    cards.push(await api(page, '/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.characters[index], displayName: `${name} ${randomUUID().slice(0, 4)}` } }));
  }
  const created = await api(page, '/sessions', {
    commandId: randomUUID(), title: `Seat return ${randomUUID().slice(0, 8)}`,
    scenario: { templateId: scenario.id, version: scenario.version },
    characters: cards.map(card => ({ templateId: card.id, version: card.version })),
  });
  const sessionId = created.sessionId as string;
  const { invites } = await api(page, `/sessions/${sessionId}/invites`);
  const seatOne = invites.find((row: { role: string; status: string }) => row.role === 'player' && row.status === 'waiting');
  const { token } = await api(page, `/sessions/${sessionId}/invites/${seatOne.id}/link`);

  const playerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    // Watch every change to the page text for the connection-lost notice, from before the first script runs.
    await playerContext.addInitScript(() => {
      (window as any).__sawLost = false;
      const look = () => { if ((document.documentElement?.textContent ?? '').includes('Connection lost')) (window as any).__sawLost = true; };
      new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const first = await playerContext.newPage();
    await first.goto(`/join/${token}`);
    await first.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(first.getByRole('heading', { name: 'Your character' })).toBeVisible();

    await page.goto(`/sessions/${sessionId}/director`);
    await page.getByTestId('setup-lobby-link').click();
    await expect(page.getByTestId('seats-with-card')).toContainText('2 of 2');
    await page.getByTestId('start-session').click();
    await expect(page.getByTestId('start-session')).toHaveCount(0);
    await page.goto(`/sessions/${sessionId}/director`);
    await expect(page.getByTestId('director-controls')).toBeVisible();
    const state = await api(page, `/sessions/${sessionId}?view=director`);
    await api(page, `/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });

    await expect(first.locator('.player-status')).toContainText(/What does .* say\?/);
    const words = 'I left a lantern on the table and nobody has asked about it yet.';
    await first.getByTestId('speech-input').fill(words);
    await first.close();

    // The same invitation link, opened again in the same browser, goes straight back to the seat with the words.
    const second = await playerContext.newPage();
    await second.goto(`/join/${token}`);
    await expect(second).toHaveURL(/\/sessions\/[^/]+\/play\?.*identity=[a-f0-9]{32}/);
    await expect(second.getByTestId('speech-input')).toHaveValue(words);
    await expect(second.locator('.app-header .status')).toHaveText('Connected');
    await expect(second.getByTestId('invite-error')).toHaveCount(0);
    expect(await second.evaluate(() => (window as any).__sawLost)).toBe(false);
    await second.close();

    // The show's play address with no identity uses the one seat this browser holds.
    const third = await playerContext.newPage();
    await third.goto(`/sessions/${sessionId}/play`);
    await expect(third.getByTestId('speech-input')).toBeVisible();
    await expect(third.getByTestId('speech-input')).toHaveValue(words);
    await expect(third.locator('.app-header .status')).toHaveText('Connected');
    expect(await third.evaluate(() => (window as any).__sawLost)).toBe(false);

    // A request that never reaches the show reads plainly and the words stay in the box.
    await third.route('**/api/sessions/*/commands', route => route.abort('failed'));
    await third.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(third.getByText(UNREACHABLE, { exact: false }).first()).toBeVisible();
    await expect(third.getByText('Your words are still in the box.', { exact: false }).first()).toBeVisible();
    await expect(third.getByTestId('speech-input')).toHaveValue(words);
    await expect(third.getByText('Failed to fetch')).toHaveCount(0);
    await third.unroute('**/api/sessions/*/commands');
    // After a failed send the button offers a second try under its own words.
    await third.getByRole('button', { name: /^Send( it anyway)?$/ }).click();
    await expect(third.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(third.getByTestId('speech-input')).toHaveValue('');

    // Another browser profile never opened this link, so it still gets the used-invitation sentence.
    const stranger = await otherContext.newPage();
    await stranger.goto(`/join/${token}`);
    await expect(stranger.getByTestId('invite-error')).toHaveText(USED);
    await expect(stranger.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);
    await stranger.goto(`/sessions/${sessionId}/play`);
    await expect(stranger.getByTestId('speech-input')).toHaveCount(0);
  } finally { await playerContext.close(); await otherContext.close(); }
});
