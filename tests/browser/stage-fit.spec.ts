import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  return page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identityOverride });
}

interface Sample { ids: string[]; outside: string[]; hasMarker: boolean; marker: string }
interface Segment { id: string; kind: string; text: string }

// Reads every line that is not hidden and reports those that leave the given box.
function sampleLines(page: Page, lineSelector: string, hiddenClass: string, boxSelector: string): Promise<Sample> {
  return page.evaluate(({ lineSelector, hiddenClass, boxSelector }) => {
    const box = document.querySelector(boxSelector)!.getBoundingClientRect();
    const ids: string[] = [];
    const outside: string[] = [];
    for (const line of Array.from(document.querySelectorAll<HTMLElement>(lineSelector))) {
      if (line.classList.contains(hiddenClass)) continue;
      const id = line.dataset.segmentId ?? '';
      ids.push(id);
      const rect = line.getBoundingClientRect();
      const inside = rect.width > 0 && rect.height > 0 && rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
      if (!inside) outside.push(`${id} line ${JSON.stringify([rect.left, rect.top, rect.right, rect.bottom])} box ${JSON.stringify([box.left, box.top, box.right, box.bottom])}`);
    }
    const marker = document.querySelector('.page-marker');
    return { ids, outside, hasMarker: !!marker, marker: marker?.textContent ?? '' };
  }, { lineSelector, hiddenClass, boxSelector });
}

async function openMore(page: Page) {
  const more = page.getByTestId('beat-more');
  if (!(await more.evaluate(node => (node as HTMLDetailsElement).open))) await more.locator('summary').first().click();
}

test('the full scene and the overlay both show every line of the latest beat, players included', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const path = `/sessions/${sessionId}`;

  let state = (await api(page, path)).body;
  async function command(caller: Page, value: Record<string, unknown>) {
    const result = await api(caller, `${path}/commands`, { commandId: randomUUID(), ...value });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.snapshot;
  }

  // Two players each send one Say line of about ten words.
  state = await command(page, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const lines = ['Who left the ledger on the counter before the club closed tonight?', 'I watched somebody carry a red key down the cellar stairs earlier.'];
  const names: string[] = [];
  for (let index = 0; index < 2; index++) {
    const character = state.characters[index];
    names.push(character.displayName);
    const grant = (await api(page, `${path}/test-seat`, { characterId: character.id })).body;
    const seat = await context.newPage();
    await seat.goto(`${path}/play?identity=${grant.identityId}`);
    await command(seat, { type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: lines[index], recipientNpcIds: [state.npcs[0].id] });
    await seat.close();
  }

  // The director selects both players, plans, locks and drafts.
  await page.reload();
  for (const name of names) await expect(page.locator('.queue-item').filter({ has: page.getByText(name, { exact: true }) }).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and roll', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish without voice' })).toBeEnabled();

  // Rewrite the script to four non-player segments of about 110 words.
  const script = [
    'The cellar door hangs open and a cold draft carries the smell of old paper and wet stone across the empty club floor while the lamps flicker low.',
    'You are not the first to ask about that ledger, and you will not be the last. Somebody wanted it gone tonight, and I would very much like to know who.',
    'Behind the bar a single glass rolls slowly toward the edge, and nobody moves to catch it as the whole room waits to see where it lands.',
    'Footsteps echo somewhere below, slow and deliberate, and every head turns toward the stairs as the red key glints once in the dim light.'
  ];
  const wordCount = script.join(' ').split(/\s+/).length;
  expect(wordCount).toBeGreaterThanOrEqual(100);
  expect(wordCount).toBeLessThanOrEqual(120);
  await expect(page.getByTestId('script-line-1')).toBeVisible();
  await expect(page.getByTestId('script-line-2')).toHaveCount(0);
  await page.getByTestId('script-line-0').click();
  await page.getByTestId('script-line-1').click();
  await page.getByTestId('script-add-line').selectOption('narration');
  await page.getByTestId('script-add-line').selectOption('narration');
  for (let index = 0; index < script.length; index++) await page.getByTestId(`script-segment-${index}`).fill(script[index]);
  await expect(page.getByRole('button', { name: 'Publish without voice' })).toBeDisabled();
  await openMore(page);
  await page.getByRole('button', { name: 'Save edits', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Publish without voice' })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish without voice' }).click();
  await expect.poll(async () => (await api(page, path)).body.history.length).toBe(1);

  const segments = (await api(page, path)).body.history[0].segments as Segment[];
  const playerSegments = segments.filter(segment => segment.kind === 'player_dialogue');
  expect(playerSegments).toHaveLength(2);
  expect(segments.filter(segment => segment.kind !== 'player_dialogue')).toHaveLength(4);
  const firstPlayer = playerSegments[0];
  expect(firstPlayer.text).toBe(lines[0]);
  const allIds = segments.map(segment => segment.id);

  // Create the main show link and read its address.
  await page.getByRole('link', { name: 'Cast & lobby' }).click();
  await page.getByTestId('stream-setup').locator('summary').first().click();
  const showRow = page.getByTestId('stream-row-show');
  await expect(showRow.getByTestId('copy-scene')).toBeVisible();
  const base = new URL((await showRow.getByTestId('copy-scene').getAttribute('data-url'))!);
  expect(base.hash).toMatch(/^#token=.+/);
  const urlFor = (layout: 'scene' | 'overlay') => {
    const url = new URL(base.toString());
    url.searchParams.set('layout', layout);
    url.searchParams.set('audio', 'off');
    return url.toString();
  };

  const scene = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const overlay = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    // Full scene: every shown line fits inside the story box, and later pages cover the rest.
    const stream = await scene.newPage();
    await stream.goto(urlFor('scene'));
    await expect(stream.locator('.scene .line').first()).toBeAttached();
    await expect(stream.locator('.scene .line')).toHaveCount(segments.length);
    await expect(stream.locator('.stage-story')).toContainText(firstPlayer.text);
    const seen = new Set<string>();
    const first = await sampleLines(stream, '.scene .line', 'off-page', '.scene .lines');
    expect(first.outside).toEqual([]);
    expect(first.ids).toContain(firstPlayer.id);
    first.ids.forEach(id => seen.add(id));
    if (first.hasMarker) expect(first.marker).toMatch(/^Part 1 of \d+$/);
    const deadline = Date.now() + 70000;
    while (allIds.some(id => !seen.has(id)) && Date.now() < deadline) {
      await stream.waitForTimeout(500);
      const sample = await sampleLines(stream, '.scene .line', 'off-page', '.scene .lines');
      expect(sample.outside).toEqual([]);
      expect(sample.ids.length).toBeGreaterThan(0);
      sample.ids.forEach(id => seen.add(id));
    }
    expect(allIds.filter(id => !seen.has(id))).toEqual([]);
    await expect(stream.locator('.stage-story')).toContainText(playerSegments[1].text);

    // Transparent overlay: the first caption chunk starts with the first player's line.
    const caption = await overlay.newPage();
    await caption.goto(urlFor('overlay'));
    await expect(caption.locator('.stage-story .line').first()).toBeAttached();
    await expect(caption.locator('.stage-story .line')).toHaveCount(segments.length);
    const chunk = await sampleLines(caption, '.stage-story .line', 'off-chunk', '.stage-story');
    expect(chunk.ids.length).toBeGreaterThan(0);
    expect(chunk.ids[0]).toBe(firstPlayer.id);
    expect(chunk.outside).toEqual([]);
    await expect(caption.locator('.stage-story .line:not(.off-chunk)').first()).toContainText(firstPlayer.text);
    for (const sample of [await sampleLines(caption, '.stage-story .line', 'off-chunk', '.stage-story')]) expect(sample.outside).toEqual([]);

    // Track cards: a long label shortens with an ellipsis, and every card stays inside the rail and the safe area.
    await expect(caption.locator('.rail-item').first()).toBeAttached();
    await caption.locator('.rail-label').first().evaluate(label => { label.textContent = 'The archive keeper grows suspicious of every stranger who asks about the cellar'; });
    const cards = await caption.evaluate(() => {
      const rail = document.querySelector('.rail')!.getBoundingClientRect();
      const label = document.querySelector<HTMLElement>('.rail-label')!;
      return {
        rail: { left: rail.left, right: rail.right },
        items: Array.from(document.querySelectorAll('.rail-item')).map(item => { const box = item.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }),
        truncated: label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis'
      };
    });
    expect(cards.items.length).toBeGreaterThan(0);
    expect(cards.truncated).toBe(true);
    for (const card of cards.items) {
      expect(card.left).toBeGreaterThanOrEqual(cards.rail.left);
      expect(card.right).toBeLessThanOrEqual(cards.rail.right);
      expect(card.right).toBeLessThanOrEqual(1824);
    }
  } finally { await Promise.all([scene.close(), overlay.close()]); }
});

const WAGER_NAMES = ['Rook', 'Seraphina Vale', 'Mara Quillon', 'Elena Torres'];
const WAGER_GOALS = [
  'Slip the ledger past the watchers on the stairs and reach the river before the bells ring',
  'Pick the lock on the iron cellar door before the night guards come back down the hall',
  'Talk the night porter into looking away while the whole back stairwell is searched',
  'Carry the wounded courier up the coal chute before the smoke fills the narrow shaft',
];
const WAGER_OUTCOMES = [
  {clean:'You reach the river unseen, the ledger stays dry and whole in your coat, and no watcher learns your name.',costly:'You reach the river with the ledger, but a watcher saw your lantern and follows you along the muddy bank.',setback:'The stairs creak, the watchers turn as one, and the ledger is torn from your hands and left behind for good.',critical:'The watchers seize you on the stairs, the ledger burns in their lantern, and the bells ring out your name.'},
  {clean:'The lock gives way at once, the door swings open without a single sound, and the cellar lies open before you.',costly:'The lock opens, but the pick snaps in the keyhole and the noise carries up the stairs to the guards.',setback:'The lock jams solid, the guards come back early, and you are caught in the hall with the broken pick in hand.',critical:'The pick snaps, the door bolts itself shut behind you, and the guards lock you in the flooding cellar overnight.'},
  {clean:'The porter shrugs, pockets the coin, and sleeps soundly through the whole hour while you search every room.',costly:'The porter agrees, but he will tell the captain exactly who paid him and why, when the morning bell rings.',setback:'The porter raises the alarm, every door in the building is barred, and the captain is sent for at once.',critical:'The porter calls the captain, names you as the thief, and every exit is barred while the whole guard closes in.'},
  {clean:'The courier is carried clear and thanks you with the name of his master, and a seat at his own table.',costly:'The courier is saved, but his wound reopens on the climb and he needs a healer within the hour or he is lost.',setback:'The chute collapses under you both and the courier is left behind in the dark, calling out for you to return.',critical:"The chute gives way, you both fall into the smoke below, and the courier's message is lost in the fire for ever."},
];
const BANDS = ['clean', 'costly', 'setback', 'critical'];
const BAND_FACES: Record<string, { faces: number[]; edge: number; total: number }> = {
  clean: { faces: [6, 5], edge: 1, total: 12 },
  costly: { faces: [4, 3], edge: 1, total: 9 },
  setback: { faces: [2, 1], edge: 0, total: 3 },
  critical: { faces: [1, 1], edge: 0, total: 3 },
};

test.setTimeout(240000);

test('the overlay shows each wager in turn without cutting it, then every dice card whole at 1920x1080', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;

  let state = (await api(page, path)).body;
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    expect(result.status, JSON.stringify(result.body).slice(0, 300)).toBe(200);
    if (!identity) state = result.body.snapshot;
    return result.body.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });

  expect(state.characters.length).toBe(4);
  const seats: string[] = [];
  for (const character of state.characters) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).body.identityId);
  const openRound = async (label: string) => {
    await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: state.session.inputEpoch });
    for (let index = 0; index < seats.length; index++) {
      await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: `${label} ${index}`, approach: 'Careful investigation' }, seats[index]);
    }
    state = (await api(page, path)).body;
    await beat({ type: 'plan_beat', submissionIds: state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
    await beat({ type: 'approve_stakes', classification: 'action', contracts: state.activeBeat.contracts });
  };

  // First round: published text-only, so the latest beat carries rolls.
  await openRound('Search the cellar');
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  const npc = state.npcs.find((item: any) => item.status === 'present');
  await beat({ type: 'edit_script', segments: [
    { kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: 'The cellar goes quiet.' },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: 'Leave by the coal chute behind the boiler, and do not stop walking until you reach the river.' },
  ] });
  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  expect(state.history).toHaveLength(1);
  // The stream shows the real beat: the four Action lines (one per Do line) come first, then the two script lines.
  expect(state.history.at(-1).segments.slice(0, 4).map((segment: any) => segment.kind)).toEqual(['player_action', 'player_action', 'player_action', 'player_action']);
  const segmentCount = state.history.at(-1).segments.length;
  expect(segmentCount).toBe(6);
  expect(state.history.at(-1).rolls.length).toBeGreaterThan(0);

  // Second round: opened with its stakes approved, so the wager is up.
  await openRound('Leave by the coal chute');
  expect(state.activeBeat.contracts.length).toBeGreaterThan(0);

  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  const url = `/stream?layout=overlay&audio=off#token=${encodeURIComponent(created.body.token)}`;

  // Only this stream page sees the rewritten snapshot: ordinary names, and one stake per actor or no stakes at all.
  const open = async (withStakes: boolean) => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
      const response = await route.fetch();
      const body = await response.json();
      while (body.characters.length < 4) {
        const n = body.characters.length;
        body.characters.push({ ...body.characters[n % body.characters.length], id: `extra-${n}` });
      }
      body.characters.forEach((character: any, index: number) => { character.displayName = WAGER_NAMES[index] ?? character.displayName; });
      const latest = body.history.at(-1);
      if (withStakes) {
        const stakes = body.activeBeat?.stakes ?? [];
        body.activeBeat.stakes = WAGER_NAMES.map((_, index) => ({
          ...stakes[index % stakes.length], id: `stake-${index}`, actorCharacterId: body.characters[index].id,
          intent: WAGER_GOALS[index], outcomes: WAGER_OUTCOMES[index],
        }));
      } else {
        if (body.activeBeat) delete body.activeBeat.stakes;
        const baseRoll = latest.rolls[0];
        latest.rolls = BANDS.map((band, index) => ({ ...baseRoll, id: `roll-${index}`, actorCharacterId: body.characters[index].id, band, ...BAND_FACES[band] }));
      }
      await route.fulfill({ response, json: body });
    });
    const stream = await context.newPage();
    await stream.goto(url);
    await expect(stream.locator('.stage-story .line[data-segment-id]')).toHaveCount(segmentCount);
    return { context, stream };
  };

  // Wager pass: every actor takes the banner in cast order, with four whole outcome texts, while the old dice stay held.
  {
    const { context, stream } = await open(true);
    try {
      const marker = stream.locator('.wager .wager-marker');
      await expect(marker).toHaveText('1 of 4');
      await expect(stream.locator('.dice')).toHaveClass(/dice-held/);
      for (let turn = 0; turn < WAGER_NAMES.length; turn++) {
        const text = `${turn + 1} of 4`;
        await expect(marker).toHaveText(text, { timeout: 15000 });
        await stream.waitForTimeout(600);
        const read = await stream.evaluate(() => {
          const wager = document.querySelector<HTMLElement>('.wager')!;
          const box = wager.getBoundingClientRect();
          const outcomes = Array.from(wager.querySelectorAll<HTMLElement>('.wager-outcomes em')).map(em => {
            const rect = em.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(em);
            const text = range.getBoundingClientRect();
            return {
              text: em.textContent ?? '', scrollHeight: em.scrollHeight, clientHeight: em.clientHeight, scrollWidth: em.scrollWidth, clientWidth: em.clientWidth,
              inside: rect.width > 0 && rect.height > 0 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5,
              textEndsInside: text.bottom <= rect.bottom + 1 && text.right <= rect.right + 1,
            };
          });
          return {
            name: wager.querySelector('.wager-goal strong')?.textContent ?? '', marker: wager.querySelector('.wager-marker')?.textContent ?? '',
            bottom: box.bottom, left: box.left, width: box.width, outcomes,
          };
        });
        const where = `turn ${text}: ${JSON.stringify(read)}`;
        expect(read.name, where).toBe(WAGER_NAMES[turn]);
        expect(read.marker, where).toBe(text);
        expect(read.bottom, where).toBeLessThanOrEqual(752);
        expect(read.left, where).toBe(480);
        expect(read.width, where).toBe(960);
        expect(read.outcomes, where).toHaveLength(4);
        for (const outcome of read.outcomes) {
          expect(outcome.text.length, where).toBeGreaterThanOrEqual(100);
          expect(outcome.scrollHeight, where).toBeLessThanOrEqual(outcome.clientHeight + 1);
          expect(outcome.scrollWidth, where).toBeLessThanOrEqual(outcome.clientWidth + 1);
          expect(outcome.inside, where).toBe(true);
          expect(outcome.textEndsInside, where).toBe(true);
        }
        expect(await stream.locator('.dice').evaluate(dice => getComputedStyle(dice).visibility === 'hidden' || getComputedStyle(dice).display === 'none'), where).toBe(true);
      }
    } finally { await context.close(); }
  }

  // Dice pass: no stakes, four ordinary names and mixed bands; every card keeps its symbol and outcome label whole.
  {
    const { context, stream } = await open(false);
    try {
      await expect(stream.locator('.wager')).toHaveCount(0);
      await expect(stream.locator('.roll')).toHaveCount(4);
      await stream.waitForTimeout(1000);
      const read = await stream.evaluate(() => {
        const dice = document.querySelector<HTMLElement>('.dice')!;
        const diceBox = dice.getBoundingClientRect();
        const cards = Array.from(dice.querySelectorAll<HTMLElement>('.roll')).map(roll => {
          const style = getComputedStyle(roll);
          const rect = roll.getBoundingClientRect();
          const content = rect.right - Number.parseFloat(style.paddingRight);
          const visible = (el: HTMLElement) => { const css = getComputedStyle(el); const box = el.getBoundingClientRect(); return css.display !== 'none' && css.visibility !== 'hidden' && box.width > 0 && box.height > 0; };
          const label = roll.querySelector<HTMLElement>('.roll-result')!;
          const symbol = roll.querySelector<HTMLElement>('.roll-symbol')!;
          const who = roll.querySelector<HTMLElement>('.roll-who')!;
          const whoStyle = getComputedStyle(who);
          const probe = document.createElement('span');
          probe.textContent = who.textContent;
          probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${whoStyle.font};letter-spacing:${whoStyle.letterSpacing};text-transform:${whoStyle.textTransform}`;
          (who.parentElement ?? document.body).appendChild(probe);
          const whoWanted = probe.getBoundingClientRect().width;
          probe.remove();
          const whoWidth = who.getBoundingClientRect().width;
          const labelBox = label.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(label.firstChild ?? label);
          const textWidth = range.getBoundingClientRect().width;
          return {
            who: who.textContent ?? '',
            whoWanted, whoWidth, whoScrollWidth: who.scrollWidth, whoClientWidth: who.clientWidth,
            label: label.textContent ?? '', labelRight: labelBox.right, labelWidth: labelBox.width, textWidth,
            labelScrollWidth: label.scrollWidth, labelClientWidth: label.clientWidth, labelEllipsis: getComputedStyle(label).textOverflow === 'ellipsis' && label.scrollWidth > label.clientWidth,
            symbolShown: visible(symbol), symbolRight: symbol.getBoundingClientRect().right, content,
            inside: rect.left >= diceBox.left - 0.5 && rect.right <= diceBox.right + 0.5 && rect.top >= diceBox.top - 0.5 && rect.bottom <= diceBox.bottom + 0.5,
          };
        });
        return { held: dice.classList.contains('dice-held'), shown: getComputedStyle(dice).visibility !== 'hidden' && getComputedStyle(dice).display !== 'none', cards };
      });
      const where = JSON.stringify(read);
      expect(read.held, where).toBe(false);
      expect(read.shown, where).toBe(true);
      expect(read.cards, where).toHaveLength(4);
      read.cards.forEach((card, index) => {
        const what = `${card.who} / ${card.label}: ${where}`;
        expect(card.who, what).toBe(WAGER_NAMES[index]);
        expect(card.label, what).toMatch(new RegExp(['Clean success', 'Success with a cost', 'Setback', 'Critical failure'][index]!));
        expect(card.whoWidth, what).toBeGreaterThanOrEqual(card.whoWanted - 0.5);
        expect(card.whoScrollWidth, what).toBeLessThanOrEqual(card.whoClientWidth);
        expect(card.symbolShown, what).toBe(true);
        expect(card.symbolRight, what).toBeLessThanOrEqual(card.content + 0.5);
        expect(card.labelRight, what).toBeLessThanOrEqual(card.content + 0.5);
        expect(Math.abs(card.labelWidth - card.textWidth), what).toBeLessThanOrEqual(1);
        expect(card.labelScrollWidth, what).toBeLessThanOrEqual(card.labelClientWidth);
        expect(card.labelEllipsis, what).toBe(false);
        expect(card.inside, what).toBe(true);
      });
    } finally { await context.close(); }
  }
});
