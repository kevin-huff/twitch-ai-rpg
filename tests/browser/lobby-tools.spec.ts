import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, test, type Page } from '@playwright/test';

const HOST = 'browser-test-host-credential-not-for-deployment';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function api(page: Page, path: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/api${path}`, { headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

async function signInHost(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill(HOST);
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('try-it-now')).toBeVisible();
}

// Seats are either empty player-written seats or host-picked library cards.
async function makeShow(page: Page, seats: Array<'player' | 'card'>) {
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, title: `Lobby tools ${randomUUID().slice(0, 6)}` } });
  const characters: unknown[] = [];
  for (const [index, kind] of seats.entries()) {
    if (kind === 'player') { characters.push({ playerWritten: true }); continue; }
    const card = await api(page, '/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.characters[index], displayName: `Card${index} ${randomUUID().slice(0, 4)}` } });
    characters.push({ templateId: card.id, version: card.version });
  }
  const created = await api(page, '/sessions', { commandId: randomUUID(), title: `Lobby tools show ${randomUUID().slice(0, 6)}`, scenario: { templateId: scenario.id, version: scenario.version }, characters });
  return { sessionId: created.sessionId as string, starter };
}

const director = (page: Page, sessionId: string) => api(page, `/sessions/${sessionId}?view=director`);
type Seat = { id: string; displayName: string };

test('the director writes cards for two waiting seats at once and neither is left writing', async ({ page }) => {
  await signInHost(page);
  const { sessionId } = await makeShow(page, ['player', 'player']);
  const [first, second] = (await director(page, sessionId)).characterDetails as Seat[];
  await page.goto(`/sessions/${sessionId}/lobby`);
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 0 of 2');

  await page.getByTestId(`write-card-for-${first.id}`).click();
  await page.getByTestId(`write-card-for-${second.id}`).click();
  await page.getByTestId(`write-card-input-${first.id}`).fill('A grumpy lighthouse keeper who hides a map');
  await page.getByTestId(`write-card-input-${second.id}`).fill('A charming singer who owes a favour');
  await page.getByTestId(`write-card-submit-${first.id}`).click();
  await page.getByTestId(`write-card-submit-${second.id}`).click();

  for (const seat of [first, second]) {
    const line = page.getByTestId(`seat-line-${seat.id}`);
    await expect(line.getByText('Read card')).toBeVisible();
    await expect(line.getByText('Writing this card…')).toHaveCount(0);
    await expect(page.getByTestId(`seat-error-${seat.id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 2 of 2');
  await expect(page.getByTestId('start-session')).toBeEnabled();
  const after = (await director(page, sessionId)).characterDetails as Array<{ approved: boolean; draft: unknown; cardSource: string }>;
  expect(after.every(character => character.approved && !character.draft && character.cardSource === 'host')).toBe(true);
});

test('Start without this seat removes a waiting seat and the seat count drops', async ({ page }) => {
  await signInHost(page);
  const { sessionId } = await makeShow(page, ['player', 'player', 'player']);
  const [, middle] = (await director(page, sessionId)).characterDetails as Seat[];
  await page.goto(`/sessions/${sessionId}/lobby`);
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 0 of 3');

  await page.getByTestId(`remove-seat-${middle.id}`).click();
  await expect(page.getByText('Remove this seat? Its invitation stops working.')).toBeVisible();
  await page.getByTestId(`remove-seat-confirm-${middle.id}`).click();
  await expect(page.getByTestId(`seat-line-${middle.id}`)).toHaveCount(0);
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 0 of 2');
  expect(((await director(page, sessionId)).characterDetails as Seat[]).some(seat => seat.id === middle.id)).toBe(false);
});

test('Copy all invitations names each line by seat, and a new main show link appears without a reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signInHost(page);
  const { sessionId } = await makeShow(page, ['player', 'player']);
  const origin = new URL(page.url()).origin;

  // Start with no active show link so the later creation is the only thing that can make one appear.
  const { links } = await api(page, `/sessions/${sessionId}/stream-links`);
  for (const link of links.filter((item: { subject: string; revokedAt: string | null }) => item.subject === 'show' && item.revokedAt === null)) {
    await api(page, `/sessions/${sessionId}/stream-links/${link.id}/revoke`, { commandId: randomUUID() });
  }

  async function copyAll() {
    await page.evaluate(() => navigator.clipboard.writeText('cleared'));
    await page.getByTestId('copy-all-invitations').click();
    const fallback = page.getByTestId('invitations-text');
    await expect.poll(async () => (await fallback.isVisible()) || (await page.evaluate(() => navigator.clipboard.readText())) !== 'cleared').toBe(true);
    const text = (await fallback.isVisible()) ? await fallback.inputValue() : await page.evaluate(() => navigator.clipboard.readText());
    return text.split('\n');
  }

  await page.goto(`/sessions/${sessionId}/lobby`);
  await expect(page.getByTestId('ready-strip')).toBeVisible();
  await expect(page.getByTestId('show-link-none')).toHaveText('No main show link yet. Make one under Stream this show.');
  await expect(page.getByTestId('ready-show-link')).toHaveCount(0);

  const [first, second] = (await director(page, sessionId)).characterDetails as Seat[];
  const before = await copyAll();
  expect(before).toHaveLength(2);
  expect(before[0]).toMatch(new RegExp(`^${escape(first.displayName)}: ${escape(origin)}/join/.+`));
  expect(before[1]).toMatch(new RegExp(`^${escape(second.displayName)}: ${escape(origin)}/join/.+`));
  expect(first.displayName).toMatch(/^Seat \d+$/);

  // Once a seat has a card, its line is named by the character.
  await page.getByTestId(`write-card-for-${first.id}`).click();
  await page.getByTestId(`write-card-input-${first.id}`).fill('A grumpy lighthouse keeper who hides a map');
  await page.getByTestId(`write-card-submit-${first.id}`).click();
  await expect(page.getByTestId(`seat-line-${first.id}`).getByText('Read card')).toBeVisible();
  const named = ((await director(page, sessionId)).characterDetails as Seat[])[0]!;
  expect(named.displayName).not.toBe(first.displayName);
  const afterCard = await copyAll();
  expect(afterCard[0]).toMatch(new RegExp(`^${escape(named.displayName)}: ${escape(origin)}/join/.+`));
  expect(afterCard[1]).toMatch(new RegExp(`^${escape(second.displayName)}: `));

  // Making the main show link under Stream this show updates the ready strip in place.
  await page.getByTestId('stream-this-show').click();
  await expect(page.getByTestId('stream-setup')).toHaveAttribute('open', '');
  await page.getByTestId('make-show-link').click();
  await expect(page.getByTestId('ready-show-link')).toBeVisible();
  const readyUrl = (await page.getByTestId('ready-show-link').getByTestId('copy-scene').getAttribute('data-url'))!;
  expect(readyUrl).toMatch(/\/stream\?layout=scene&audio=present#token=/);
  expect(readyUrl).not.toContain('bg=');
  const setupUrl = (await page.getByTestId('stream-row-show').getByTestId('copy-scene').getAttribute('data-url'))!;
  expect(setupUrl).toBe(readyUrl);
  await expect(page.getByTestId('show-link-none')).toHaveCount(0);

  // Turning it off takes the link out of the strip again.
  const showRow = page.getByTestId('stream-row-show');
  await showRow.getByTestId('turn-off').click();
  await showRow.getByTestId('turn-off-confirm').click();
  await expect(page.getByTestId('ready-show-link')).toHaveCount(0);
});

test('Take it back returns a sent line to the box unsent, and a taken-back pause request leaves the note box empty', async ({ page, context }) => {
  await signInHost(page);
  const { sessionId } = await makeShow(page, ['card', 'card']);
  let state = await director(page, sessionId);
  await api(page, `/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'start_session', expectedStateRevision: state.session.stateRevision });
  state = await director(page, sessionId);
  await api(page, `/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const grant = await api(page, `/sessions/${sessionId}/test-seat`, { characterId: state.characterDetails[0].id });

  const seat = await context.newPage();
  await seat.goto(`/sessions/${sessionId}/play?identity=${grant.identityId}`);
  await expect(seat.getByTestId('speech-input')).toBeVisible();
  await seat.getByTestId('speech-input').fill('Has anyone seen my scarf?');
  await seat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(seat.getByRole('status').filter({ hasText: 'Saved. The director has your line.' })).toBeVisible();
  await expect(seat.getByTestId('speech-input')).toHaveValue('');
  await seat.getByRole('button', { name: 'Take it back' }).click();
  await expect(seat.getByTestId('speech-input')).toHaveValue('Has anyone seen my scarf?');
  await expect(seat.getByRole('button', { name: 'Take it back' })).toHaveCount(0);
  await expect(seat.getByText('Take this line back?')).toHaveCount(0);

  // Nothing is left sent: the words are only in the box, so the director's queue is empty again.
  const queued = await director(page, sessionId);
  expect(queued.submissions.filter((item: { status: string }) => ['queued', 'selected'].includes(item.status))).toHaveLength(0);

  // A pause request is a canned note, so taking it back must not put its text in the note box.
  await seat.getByRole('button', { name: 'Ask for a pause' }).click();
  await expect(seat.getByRole('status').filter({ hasText: 'Pause requested.' })).toBeVisible();
  await seat.getByRole('button', { name: 'Take it back' }).click();
  await expect(seat.getByRole('button', { name: 'Take it back' })).toHaveCount(0);
  await seat.getByRole('button', { name: 'Ask the director privately' }).click();
  await expect(seat.getByTestId('note-input')).toBeVisible();
  await expect(seat.getByTestId('note-input')).toHaveValue('');
});

test('Card waiting to be used: Use this card makes the seat count', async ({ page }) => {
  await signInHost(page);
  const { sessionId, starter } = await makeShow(page, ['player', 'player']);
  const [waiting] = (await director(page, sessionId)).characterDetails as Seat[];

  // A card waiting for the director comes only from older sessions, so the test puts one straight into the harness database.
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://rpg@127.0.0.1:55432/rpg_test' });
  try {
    const draft = { ...starter.characters[0], displayName: 'Legacy Draft Hero' };
    const updated = await pool.query('UPDATE characters SET data = data || $1::jsonb WHERE id=$2 AND session_id=$3', [JSON.stringify({ approved: false, draft }), waiting.id, sessionId]);
    expect(updated.rowCount).toBe(1);
  } finally { await pool.end(); }

  await page.goto(`/sessions/${sessionId}/lobby`);
  await expect(page.getByTestId(`card-waiting-${waiting.id}`)).toHaveText('Card waiting to be used');
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 0 of 2');
  await page.getByTestId(`use-card-${waiting.id}`).click();
  await expect(page.getByTestId(`card-waiting-${waiting.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`seat-line-${waiting.id}`).getByText('Read card')).toBeVisible();
  await expect(page.getByTestId('seats-with-card')).toHaveText('Seats with a card: 1 of 2');
  const after = (await director(page, sessionId)).characterDetails.find((item: Seat) => item.id === waiting.id);
  expect(after.approved).toBe(true);
  expect(after.draft).toBeNull();
  expect(after.displayName).toBe('Legacy Draft Hero');
});
