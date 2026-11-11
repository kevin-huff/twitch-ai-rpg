import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

const NAMES = ['Seraphina Vale', 'Tobias Reed', 'Mara Quillon', 'Elena Torres', 'Jonah Pike', 'Lucia Ferrante', 'Bartholomew Okoro', 'Magdalena Ash', 'Elenora Whitby', 'Cornelius Dray', 'Philippa Stroud', 'Ignatius Bell'];
const LAST_CHANCE_SENTENCE = (name: string) => `${name} is down. If nobody saves ${name} this round, one roll decides: 7 or more and ${name} pulls through; 6 or less, or double 1s, and ${name} dies.`;
const ROLLED_SENTENCE = (name: string) => `${name} is down. The dice are rolled. The story will tell what happens.`;

type Body = any;
// The rewrite each stream page applies to the stage snapshot before it draws.
let rewrite: (body: Body) => void = () => {};

function extendCast(body: Body, count: number) {
  while (body.characters.length < count) {
    const n = body.characters.length;
    body.characters.push({ ...body.characters[n % 4], id: `extra-${n}` });
  }
  body.characters.forEach((character: any, index: number) => { character.displayName = NAMES[index] ?? character.displayName; });
}

async function openStream(browser: Browser, url: string, size: { width: number; height: number }) {
  const context = await browser.newContext({ viewport: size });
  await context.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
    const response = await route.fetch();
    const body = await response.json();
    rewrite(body);
    await route.fulfill({ response, json: body });
  });
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

interface DiceRead { rolls: number; lastChanceCards: { result: string; mark: string; last: string }[]; issues: string[] }

// Reads every roll card of the one dice box on the page: each must lie inside the box, and each last-chance card must show Last chance and its result uncut.
function readDice(page: Page): Promise<DiceRead> {
  return page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const dice = document.querySelector<HTMLElement>('.dice')!;
    const diceBox = box(dice);
    const rolls = Array.from(dice.querySelectorAll<HTMLElement>('.roll'));
    const issues: string[] = [];
    const wantedWidth = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.textContent = el.textContent;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};letter-spacing:${style.letterSpacing};text-transform:${style.textTransform}`;
      (el.parentElement ?? document.body).appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    const whole = (roll: HTMLElement, el: HTMLElement | null, what: string) => {
      if (!el) { issues.push(`${what}: missing`); return; }
      const rect = box(el);
      const card = box(roll);
      const style = getComputedStyle(roll);
      const content = card.right - Number.parseFloat(style.paddingRight);
      const name = `${what} "${el.textContent}"`;
      if (!rect.width || !rect.height) issues.push(`${name}: not shown`);
      if (rect.right > content + 0.5) issues.push(`${name}: right ${Math.round(rect.right)} > content ${Math.round(content)}`);
      if (rect.right > card.right + 0.5 || rect.left < card.left - 0.5) issues.push(`${name}: outside its roll card`);
      const wanted = wantedWidth(el);
      if (rect.width < wanted - 0.2) issues.push(`${name}: renders ${rect.width.toFixed(2)} px wide for ${wanted.toFixed(2)} px of text`);
      if (el.scrollWidth > el.clientWidth + 1) issues.push(`${name}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      if (getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') issues.push(`${name}: hidden`);
    };
    const lastChanceCards: DiceRead['lastChanceCards'] = [];
    rolls.forEach((roll, index) => {
      const rect = box(roll);
      if (!(rect.left >= diceBox.left - 0.5 && rect.right <= diceBox.right + 0.5 && rect.top >= diceBox.top - 0.5 && rect.bottom <= diceBox.bottom + 0.5)) {
        issues.push(`roll ${index} lies outside the dice box ${JSON.stringify([Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)])} vs ${JSON.stringify([Math.round(diceBox.left), Math.round(diceBox.top), Math.round(diceBox.right), Math.round(diceBox.bottom)])}`);
      }
      const mark = roll.dataset.lastChance;
      if (!mark) return;
      const last = roll.querySelector<HTMLElement>('.roll-last');
      const result = roll.querySelector<HTMLElement>('.roll-result');
      whole(roll, last, `roll ${index} last chance`);
      whole(roll, result, `roll ${index} result`);
      lastChanceCards.push({ result: result?.textContent?.trim() ?? '', mark, last: last?.textContent?.trim() ?? '' });
    });
    return { rolls: rolls.length, lastChanceCards, issues };
  });
}

interface CardRead { marker: string; text: string; title: string; hasCard: boolean; issues: string[] }

// Reads the card on show: whole inside the wager box (and the story box on the full scene), nothing clamped.
function readCard(page: Page): Promise<CardRead> {
  return page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const wager = document.querySelector<HTMLElement>('.wager')!;
    const story = wager.closest<HTMLElement>('.stage-story');
    const issues: string[] = [];
    const card = wager.querySelector<HTMLElement>('[data-card="last-chance"]');
    const text = card?.querySelector<HTMLElement>('.wager-last') ?? null;
    if (text) {
      const rect = box(text);
      const inside = (outer: DOMRect) => rect.left >= outer.left - 0.5 && rect.right <= outer.right + 0.5 && rect.top >= outer.top - 0.5 && rect.bottom <= outer.bottom + 0.5;
      if (!rect.width || !rect.height) issues.push('card text not shown');
      if (!inside(box(wager))) issues.push(`card text outside the wager box ${JSON.stringify([rect.left, rect.top, rect.right, rect.bottom])} vs ${JSON.stringify([box(wager).left, box(wager).top, box(wager).right, box(wager).bottom])}`);
      if (story && !inside(box(story))) issues.push('card text outside the story box');
      if (text.scrollHeight > text.clientHeight + 1) issues.push(`scrollHeight ${text.scrollHeight} > clientHeight ${text.clientHeight}`);
      if (text.scrollWidth > text.clientWidth + 1) issues.push(`scrollWidth ${text.scrollWidth} > clientWidth ${text.clientWidth}`);
      const range = document.createRange();
      range.selectNodeContents(text);
      if (range.getBoundingClientRect().bottom > rect.bottom + 1) issues.push('text runs below its block');
      if (getComputedStyle(text).webkitLineClamp !== 'none' && getComputedStyle(text).webkitLineClamp !== '') issues.push(`line clamp ${getComputedStyle(text).webkitLineClamp}`);
    }
    const title = card?.querySelector<HTMLElement>('.wager-name, .wager-goal');
    return {
      marker: wager.querySelector('.wager-marker')?.textContent ?? '', text: text?.textContent ?? '', title: title?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      hasCard: !!card, issues,
    };
  });
}

interface ChipRead { text: string; pulses: number; issues: string[] }

function readChip(page: Page): Promise<ChipRead> {
  return page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const head = document.querySelector<HTMLElement>('.scene-head')!;
    const chip = document.querySelector<HTMLElement>('.scene-head .chip')!;
    const issues: string[] = [];
    const chipBox = box(chip);
    const headBox = box(head);
    if (!(chipBox.left >= headBox.left - 0.5 && chipBox.right <= headBox.right + 0.5 && chipBox.top >= headBox.top - 0.5 && chipBox.bottom <= headBox.bottom + 0.5)) issues.push(`chip ${JSON.stringify([chipBox.left, chipBox.top, chipBox.right, chipBox.bottom])} outside the head ${JSON.stringify([headBox.left, headBox.top, headBox.right, headBox.bottom])}`);
    if (chip.scrollWidth > chip.clientWidth + 1) issues.push(`chip scrollWidth ${chip.scrollWidth} > clientWidth ${chip.clientWidth}`);
    const range = document.createRange();
    range.selectNodeContents(chip.firstChild!);
    const label = range.getBoundingClientRect();
    if (label.right > chipBox.right + 0.5 || label.left < chipBox.left - 0.5) issues.push('label leaves the chip');
    const pulse = chip.querySelector<HTMLElement>('.chip-pulse');
    if (pulse && box(pulse).right > chipBox.right + 0.5) issues.push('pulse leaves the chip');
    const badge = document.querySelector<HTMLElement>('.scene-head .ai-badge');
    if (badge) {
      const b = box(badge);
      const overlap = chipBox.left < b.right && chipBox.right > b.left && chipBox.top < b.bottom && chipBox.bottom > b.top;
      if (overlap) issues.push('chip overlaps the AI badge');
    }
    return { text: chip.firstChild?.textContent ?? '', pulses: chip.querySelectorAll('.chip-pulse').length, issues };
  });
}

test.setTimeout(300000);

test('last chances and deaths read plainly on the dice, the stakes, the party and the scene chip', async ({ page, browser }) => {
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

  // First round: published text-only, so the latest beat carries rolls and lines.
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
  expect(state.history.at(-1).rolls.length).toBeGreaterThan(0);

  // Second round: open with its stakes approved, so the live round has real stakes to rewrite.
  await openRound('Leave by the coal chute');
  expect(state.activeBeat.contracts.length).toBeGreaterThan(0);

  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  const hash = `#token=${encodeURIComponent(created.body.token)}`;
  const sceneUrl = `/stream?layout=scene&audio=off${hash}`;
  const overlayUrl = `/stream?layout=overlay&audio=off${hash}`;
  const stakesPiece = `/stream?view=stakes&audio=off${hash}`;
  const dicePiece = `/stream?view=dice&audio=off${hash}`;
  const FULL = { width: 1920, height: 1080 };

  // (1) Dice: 1, 5 and 12 rolls; a last chance that died and, from 5 rolls up, one that pulled through (and a critical one that died at 12).
  const diceRewrite = (count: number) => (body: Body) => {
    extendCast(body, count);
    if (body.activeBeat) { delete body.activeBeat.stakes; body.activeBeat.lastChanceFor = []; }
    const latest = body.history.at(-1);
    const baseRoll = latest.rolls[0];
    latest.rolls = Array.from({ length: count }, (_, index) => ({
      ...baseRoll, id: `roll-${index}`, actorCharacterId: body.characters[index].id, band: 'costly', faces: [4, 3], edge: 1, total: 9,
    }));
    const lastChance = (index: number, band: string, faces: [number, number], total: number) => {
      const roll = { ...latest.rolls[index], band, faces, total, edge: 0, lastChance: true, contractId: `last-chance:${body.characters[index].id}` };
      latest.rolls[index] = roll;
    };
    lastChance(0, 'setback', [2, 3], 5);
    if (count >= 5) lastChance(1, 'costly', [4, 5], 9);
    if (count >= 12) lastChance(2, 'critical', [1, 1], 2);
  };
  const expectedDice = (count: number) => {
    const list = [{ result: 'Dies', mark: 'dies' }];
    if (count >= 5) list.push({ result: 'Pulls through', mark: 'pulls-through' });
    if (count >= 12) list.push({ result: 'Dies', mark: 'dies' });
    return list;
  };
  const diceSurfaces = [
    { label: 'dice piece', url: dicePiece, size: { width: 1440, height: 144 } },
    { label: 'overlay', url: overlayUrl, size: FULL },
    { label: 'scene layout', url: sceneUrl, size: FULL },
  ];
  for (const count of [1, 5, 12]) {
    rewrite = diceRewrite(count);
    for (const surface of diceSurfaces) {
      const { context, page: stream } = await openStream(browser, surface.url, surface.size);
      try {
        await expect(stream.locator('.dice .roll')).toHaveCount(count, { timeout: 20000 });
        await stream.waitForTimeout(500);
        const read = await readDice(stream);
        const where = `${surface.label} with ${count} rolls: ${JSON.stringify(read)}`;
        expect(read.issues, where).toEqual([]);
        expect(read.lastChanceCards.map(({ result, mark }) => ({ result, mark })), where).toEqual(expectedDice(count));
        for (const card of read.lastChanceCards) expect(card.last, where).toBe('Last chance');
        // The ordinary cards keep the band words and carry no last-chance mark.
        await expect(stream.locator('.dice .roll:not([data-last-chance]) .roll-last'), where).toHaveCount(0);
        await stream.screenshot({ path: test.info().outputPath(`dice-${surface.label.replace(/\s+/g, '-')}-${count}.png`) });
      } finally { await context.close(); }
    }
  }

  // (2) The last-chance card: real stake first, then the card; rolled sentence once locked; none without lastChanceFor; alone when there are no stakes.
  const cardRewrite = (options: { phase: string; stakes: boolean; lastChanceFor: number[] }) => (body: Body) => {
    extendCast(body, 4);
    body.characters[1].condition = 'down';
    const real = body.activeBeat.stakes.slice(0, 1);
    body.activeBeat.stakesApproved = true;
    body.activeBeat.phase = options.phase;
    body.activeBeat.stakes = options.stakes ? real : [];
    body.activeBeat.lastChanceFor = options.lastChanceFor.map(index => body.characters[index].id);
  };
  const cardSurfaces = [
    { label: 'stakes piece', url: stakesPiece, size: { width: 960, height: 612 } },
    { label: 'overlay', url: overlayUrl, size: FULL },
    { label: 'scene layout', url: sceneUrl, size: FULL },
  ];
  const downName = NAMES[1]!;
  const cardCases = [
    { label: 'stakes approved', options: { phase: 'stakes_review', stakes: true, lastChanceFor: [1] }, sentence: LAST_CHANCE_SENTENCE(downName), rotates: true },
    { label: 'dice rolled', options: { phase: 'locked', stakes: true, lastChanceFor: [1] }, sentence: ROLLED_SENTENCE(downName), rotates: true },
    { label: 'no real stakes, locked', options: { phase: 'locked', stakes: false, lastChanceFor: [1] }, sentence: ROLLED_SENTENCE(downName), rotates: false },
  ];
  for (const scenario of cardCases) {
    rewrite = cardRewrite(scenario.options);
    for (const surface of cardSurfaces) {
      const { context, page: stream } = await openStream(browser, surface.url, surface.size);
      try {
        await expect(stream.locator('.wager')).toBeVisible({ timeout: 20000 });
        const where = `${scenario.label} on the ${surface.label}`;
        if (scenario.rotates) {
          // The real stake comes first; the card follows once the rotation reaches it.
          const first = await readCard(stream);
          expect(first.marker, where).toMatch(/^[12] of 2$/);
          if (first.marker === '1 of 2') expect(first.hasCard, `${where}: the real stake shows before the card`).toBe(false);
        }
        await expect(stream.locator('.wager [data-card="last-chance"]'), where).toHaveCount(1, { timeout: 20000 });
        await stream.waitForTimeout(400);
        const read = await readCard(stream);
        expect(read.issues, `${where}: ${JSON.stringify(read)}`).toEqual([]);
        expect(read.text, where).toBe(scenario.sentence);
        expect(read.title, where).toContain(`${downName}`);
        expect(read.title, where).toMatch(/ · Last chance$/);
        expect(read.text, `${where}: no roll total in the card`).not.toMatch(/\btotal\b|rolled \d/);
        if (scenario.rotates) expect(read.marker, where).toBe('2 of 2');
        else expect(read.marker, where).toBe('');
        await stream.screenshot({ path: test.info().outputPath(`card-${scenario.label.replace(/[\s,]+/g, '-')}-${surface.label.replace(/\s+/g, '-')}.png`) });
      } finally { await context.close(); }
    }
  }
  // Nobody is down: no card, only the real stake.
  rewrite = cardRewrite({ phase: 'stakes_review', stakes: true, lastChanceFor: [] });
  for (const surface of cardSurfaces) {
    const { context, page: stream } = await openStream(browser, surface.url, surface.size);
    try {
      await expect(stream.locator('.wager')).toBeVisible({ timeout: 20000 });
      await stream.waitForTimeout(1000);
      await expect(stream.locator('[data-card="last-chance"]'), surface.label).toHaveCount(0);
      await expect(stream.locator('.wager-marker'), surface.label).toHaveCount(0);
    } finally { await context.close(); }
  }

  // (3) Six players, one down and one dead: the scene layout's party shows both words.
  rewrite = body => {
    extendCast(body, 6);
    body.characters[2].condition = 'down';
    body.characters[3].condition = 'dead';
    if (body.activeBeat) { delete body.activeBeat.stakes; body.activeBeat.lastChanceFor = []; }
  };
  {
    const { context, page: stream } = await openStream(browser, sceneUrl, FULL);
    try {
      await expect(stream.locator('.party .party-card')).toHaveCount(6, { timeout: 20000 });
      const read = await stream.evaluate(() => {
        const party = document.querySelector<HTMLElement>('.party')!;
        const partyBox = party.getBoundingClientRect();
        const flags = Array.from(party.querySelectorAll<HTMLElement>('.needs-help')).map(el => {
          const rect = el.getBoundingClientRect();
          const card = el.closest<HTMLElement>('.party-card')!.getBoundingClientRect();
          return { text: el.textContent?.trim() ?? '', cut: el.scrollWidth > el.clientWidth + 1, outsideCard: rect.right > card.right + 0.5 || rect.left < card.left - 0.5, outsideParty: rect.right > partyBox.right + 0.5, shown: rect.width > 0 };
        });
        return { flags, pips: party.querySelectorAll('.pips').length };
      });
      expect(read.flags.map(flag => flag.text).sort(), JSON.stringify(read)).toEqual(['Dead', 'Down']);
      for (const flag of read.flags) {
        expect(flag.shown, JSON.stringify(read)).toBe(true);
        expect(flag.cut || flag.outsideCard || flag.outsideParty, JSON.stringify(read)).toBe(false);
      }
      expect(read.pips, 'strain pips stay dropped with six players').toBe(0);
      await stream.screenshot({ path: test.info().outputPath('party-six.png') });
    } finally { await context.close(); }
  }

  // (4) The scene layout's chip for each of the six states.
  const chipCases: { label: string; waiting: boolean; apply: (body: Body) => void }[] = [
    { label: 'Live', waiting: false, apply: body => { body.activeBeat = null; } },
    { label: 'Taking lines', waiting: true, apply: body => { body.activeBeat.phase = 'collecting'; body.activeBeat.planning = false; delete body.activeBeat.stakesApproved; } },
    { label: 'Setting stakes', waiting: true, apply: body => { body.activeBeat.phase = 'collecting'; body.activeBeat.planning = true; delete body.activeBeat.stakesApproved; } },
    { label: 'Stakes are set', waiting: false, apply: body => { body.activeBeat.phase = 'stakes_review'; body.activeBeat.planning = false; body.activeBeat.stakesApproved = true; } },
    { label: 'Writing the story', waiting: true, apply: body => { body.activeBeat.phase = 'locked'; body.activeBeat.planning = false; body.activeBeat.stakesApproved = true; } },
    { label: 'Story coming up', waiting: true, apply: body => { body.activeBeat.phase = 'draft_review'; body.activeBeat.planning = false; body.activeBeat.stakesApproved = true; } },
  ];
  for (const scenario of chipCases) {
    rewrite = body => { scenario.apply(body); };
    const { context, page: stream } = await openStream(browser, sceneUrl, FULL);
    try {
      await expect(stream.locator('.scene-head .chip')).toContainText(scenario.label, { timeout: 20000 });
      await stream.waitForTimeout(300);
      const read = await readChip(stream);
      const where = `${scenario.label}: ${JSON.stringify(read)}`;
      expect(read.text, where).toBe(scenario.label);
      expect(read.issues, where).toEqual([]);
      expect(read.pulses, where).toBe(scenario.waiting ? 1 : 0);
      await stream.screenshot({ path: test.info().outputPath(`chip-${scenario.label.replace(/\s+/g, '-')}.png`) });
    } finally { await context.close(); }
  }
});
