import { describe, expect, it } from 'vitest';
import type { Roll, SessionSnapshot } from '@rpg/contracts';
import { AI_BADGE, bandLabel, bandSymbol, helperCredit, initials, rollBreakdown, slateKind, sortRolls, speakerName, speakerRole, statusLabel, traitName, wagerOutcomes } from './stage-format';

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
});
