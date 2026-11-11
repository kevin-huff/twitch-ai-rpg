import { describe, expect, it } from 'vitest';
import type { Roll, SessionSnapshot } from '@rpg/contracts';
import { AI_BADGE, bandLabel, bandSymbol, helperCredit, initials, lastChanceCardText, lastChanceResult, rollBreakdown, rollSentence, stageCards, stageChip, slateKind, sortRolls, speakerName, speakerRole, statusLabel, traitName, wagerOutcomes } from './stage-format';

const roll = (id: string, actor: string, extra: Partial<Roll> = {}) =>
  ({ id, actorCharacterId: actor, faces: [4, 5], trait: 'wits', traitModifier: 1, edge: 1, ...extra }) as Roll;
const snap = (status: string, history: unknown[] = []) => ({ session: { status }, history }) as unknown as SessionSnapshot;

describe('stage-format', () => {
  it('builds initials', () => {
    expect(initials('mara vale')).toBe('MV');
    expect(initials('Ada Lovelace King')).toBe('AL');
    expect(initials('  Solo ')).toBe('S');
  });
  it('names speakers', () => {
    expect(speakerName({ kind: 'npc_dialogue', speaker: { entityId: 'a', displayName: 'Bram' } })).toBe('Bram');
    expect(speakerName({ kind: 'system', speaker: null })).toBe('The show');
    expect(speakerName({ kind: 'narration', speaker: null })).toBe('Narrator');
  });
  it('names speaker roles', () => {
    expect(speakerRole({ kind: 'narration' })).toBe('Narrator');
    expect(speakerRole({ kind: 'system' })).toBe('Narrator');
    expect(speakerRole({ kind: 'npc_dialogue' })).toBe('Character');
    expect(speakerRole({ kind: 'player_dialogue' })).toBe('Player');
    expect(speakerRole({ kind: 'player_action' })).toBe('Action');
  });
  it('labels and symbols bands distinctly', () => {
    expect(bandLabel('clean')).toBe('Clean success');
    expect(bandLabel('costly')).toBe('Success with a cost');
    expect(bandLabel('setback')).toBe('Setback');
    expect(bandLabel('critical' as never)).toBe('Critical failure');
    expect(bandSymbol('critical' as never)).toBe('!');
    const bands = ['clean', 'costly', 'setback', 'critical'] as never[];
    expect(new Set(bands.map(bandSymbol)).size).toBe(4);
    expect(new Set(bands.map(bandLabel)).size).toBe(4);
  });
  it('capitalises traits', () => expect(traitName('finesse')).toBe('Finesse'));
  it('describes rolls', () => {
    expect(rollBreakdown(roll('r', 'a'))).toBe('4 + 5 + Wits 1 + Edge 1');
    expect(rollBreakdown(roll('r', 'a', { edge: 0, traitModifier: 0 }))).toBe('4 + 5 + Wits 0');
  });
  it('sorts rolls in cast order, strangers last, stable', () => {
    const rolls = [roll('1', 'x'), roll('2', 'b'), roll('3', 'a'), roll('4', 'y')];
    expect(sortRolls(rolls, [{ id: 'a' }, { id: 'b' }]).map(r => r.id)).toEqual(['3', '2', '1', '4']);
  });
  it('picks slates', () => {
    expect(slateKind(snap('lobby'))).toBe('lobby');
    expect(slateKind(snap('paused', [1]))).toBe('paused');
    expect(slateKind(snap('ended'))).toBe('ended');
    expect(slateKind(snap('live'))).toBe('waiting');
    expect(slateKind(snap('live', [1]))).toBeNull();
  });
  it('lets a first wager show instead of the waiting slate', () => {
    const withStakes = { ...snap('live'), role: 'stage', activeBeat: { stakes: [{ id: 'k1' }] } } as unknown as SessionSnapshot;
    expect(slateKind(withStakes)).toBeNull();
    const noStakes = { ...snap('live'), role: 'stage', activeBeat: { stakes: [] } } as unknown as SessionSnapshot;
    expect(slateKind(noStakes)).toBe('waiting');
    const paused = { ...snap('paused'), role: 'stage', activeBeat: { stakes: [{ id: 'k1' }] } } as unknown as SessionSnapshot;
    expect(slateKind(paused)).toBe('paused');
  });
  it('labels status', () => {
    expect(statusLabel('live', false)).toBe('Reconnecting');
    expect(statusLabel('lobby', true)).toBe('Starting soon');
    expect(statusLabel('paused', true)).toBe('Paused');
    expect(statusLabel('ended', true)).toBe('Ended');
    expect(statusLabel('live', true)).toBe('Live');
  });
  it('exports the AI badge', () => expect(AI_BADGE).toBe('AI-generated narration and character voices'));
  it('lists only the outcomes a ruling can produce', () => {
    const outcomes = { clean: 'It opens.', costly: 'It opens, loudly.', setback: 'It jams.' };
    expect(wagerOutcomes({ ruling: 'check', outcomes }).map(line => `${line.label}: ${line.text}`)).toEqual([
      '10+ Clean success: It opens.', '7-9 Success with a cost: It opens, loudly.', '6 or less Setback: It jams.',
    ]);
    const withCritical = wagerOutcomes({ ruling: 'check', outcomes: { ...outcomes, critical: 'It collapses.' } as never });
    expect(withCritical).toHaveLength(4);
    expect(withCritical[3]).toEqual({ label: 'Double 1s Critical failure', text: 'It collapses.' });
    expect(wagerOutcomes({ ruling: 'check', outcomes: { ...outcomes, critical: '  ' } as never })).toHaveLength(3);
    expect(wagerOutcomes({ ruling: 'no_check', outcomes })).toEqual([{ label: 'No roll needed', text: 'It opens.' }]);
    expect(wagerOutcomes({ ruling: 'blocked', outcomes })).toEqual([{ label: 'Blocked', text: 'It jams.' }]);
  });
  it('credits helpers and adds the Edge only when a check gets it', () => {
    expect(helperCredit({ ruling: 'check', edge: 1 }, ['Ren', 'Ivy'])).toBe('With Ren, Ivy (+1 Edge)');
    expect(helperCredit({ ruling: 'check', edge: 0 }, ['Ren'])).toBe('With Ren');
    expect(helperCredit({ ruling: 'no_check', edge: 1 }, ['Ren'])).toBe('With Ren');
  });
  it('words last-chance rolls', () => {
    expect(rollBreakdown(roll('r', 'a', { lastChance: true, faces: [3, 6] }))).toBe('3 + 6');
    expect(rollBreakdown(roll('r', 'a'))).toBe('4 + 5 + Wits 1 + Edge 1');
    expect(rollSentence({ total: 9, band: 'clean' }, 'Mara')).toBe('Mara rolled 9: Clean success');
    expect(rollSentence({ total: 2, band: 'critical', lastChance: true }, 'Mara')).toBe("Mara's last chance rolled 2: dies");
    expect(rollSentence({ total: 8, band: 'costly', lastChance: true }, 'Mara')).toBe("Mara's last chance rolled 8: pulls through");
  });
});

describe('stage chip and cards', () => {
  const view = (status: string, beat: unknown, role = 'stage') => ({ role, session: { status }, activeBeat: beat, characters: [{ id: 'a' }, { id: 'b' }] }) as unknown as SessionSnapshot;
  it('words every stage', () => {
    const chip = (beat: unknown, status = 'live', connected = true) => stageChip(view(status, beat), connected);
    expect(chip(null)).toEqual({ label: 'Live', warn: false, waiting: false });
    expect(chip({ phase: 'published' }).label).toBe('Live');
    expect(chip({ phase: 'collecting' })).toEqual({ label: 'Taking lines', warn: false, waiting: true });
    expect(chip({ phase: 'collecting', planning: true }).label).toBe('Setting stakes');
    expect(chip({ phase: 'stakes_review', stakesApproved: false }).label).toBe('Setting stakes');
    expect(chip({ phase: 'stakes_review', stakesApproved: true, planning: true }).label).toBe('Setting stakes');
    expect(chip({ phase: 'stakes_review', stakesApproved: true })).toEqual({ label: 'Stakes are set', warn: false, waiting: false });
    expect(chip({ phase: 'locked' })).toEqual({ label: 'Writing the story', warn: false, waiting: true });
    expect(chip({ phase: 'draft_review' })).toEqual({ label: 'Story coming up', warn: false, waiting: true });
    expect(chip({ phase: 'locked' }, 'live', false)).toEqual({ label: 'Reconnecting', warn: true, waiting: false });
    expect(chip({ phase: 'locked' }, 'paused')).toEqual({ label: 'Paused', warn: true, waiting: false });
    expect(chip(null, 'lobby').label).toBe('Starting soon');
    expect(chip(null, 'ended').label).toBe('Ended');
  });
  it('orders stakes then last-chance cards', () => {
    const stake = (id: string, actor: string) => ({ id, actorCharacterId: actor });
    const beat = { phase: 'stakes_review', stakesApproved: true, stakes: [stake('s2', 'b'), stake('s1', 'a')], lastChanceFor: ['b', 'a'] };
    const cards = stageCards(view('live', beat), null);
    expect(cards.map(card => card.id)).toEqual(['s1', 's2', 'last-chance:a', 'last-chance:b']);
    expect(cards[2]).toMatchObject({ kind: 'last-chance', characterId: 'a', rolled: false });
    expect(stageCards(view('live', { ...beat, phase: 'locked' }), 'b').map(card => card.id)).toEqual(['s2', 'last-chance:b']);
    expect((stageCards(view('live', { ...beat, phase: 'draft_review' }), null)[2] as { rolled: boolean }).rolled).toBe(true);
    expect(stageCards(view('live', { ...beat, stakesApproved: false }), null).map(card => card.id)).toEqual(['s1', 's2']);
    expect(stageCards(view('live', beat, 'director'), null)).toEqual([]);
    expect(stageCards(view('live', beat), 'zzz')).toEqual([]);
    expect(stageCards(view('live', { phase: 'locked', stakesApproved: true, stakes: [], lastChanceFor: ['a'] }), null).map(card => card.id)).toEqual(['last-chance:a']);
  });
  it('words last chance cards and results', () => {
    expect(lastChanceCardText('Rook', false)).toBe('Rook is down. If nobody saves Rook this round, one roll decides: 7 or more and Rook pulls through; 6 or less, or double 1s, and Rook dies.');
    expect(lastChanceCardText('Rook', true)).toBe('Rook is down. The dice are rolled. The story will tell what happens.');
    expect(lastChanceResult('clean')).toBe('Pulls through');
    expect(lastChanceResult('costly')).toBe('Pulls through');
    expect(lastChanceResult('setback')).toBe('Dies');
    expect(lastChanceResult('critical')).toBe('Dies');
  });
});
