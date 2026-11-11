import { describe, expect, it } from 'vitest';
import type { PublicBeat, Submission } from '@rpg/contracts';
import { playerStatus } from './player-status';

const beat = (over: Partial<PublicBeat> = {}): PublicBeat => ({ id: 'beat-1', kind: 'conversation', phase: 'collecting', revision: 1, stakes: [], locked: false, ...over });
const line = (over: Partial<Submission> = {}): Submission => ({ id: 's1', sessionId: 'show', characterId: 'pc-1', contextBeatId: 'beat-1', inputEpoch: 0, revision: 1, kind: 'say', text: 'Hello', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'queued', ...over });
const status = (over: Partial<Parameters<typeof playerStatus>[0]> = {}) => playerStatus({ sessionStatus: 'live', beat: beat(), own: [], ...over });

describe('playerStatus', () => {
  it('goes straight to the turn status for a started seat', () => {
    expect(status({ beat: beat() })).toMatchObject({ headline: 'What does your character say?', tone: 'act' });
    expect(status({ beat: null })).toMatchObject({ headline: 'Waiting for the next turn', tone: 'wait' });
  });
  it('ends the show ahead of everything else', () => {
    expect(status({ sessionStatus: 'ended' })).toEqual({ headline: 'The show is over', detail: 'Thanks for playing. You can close this page.', tone: 'wait' });
    expect(status({ sessionStatus: 'ended', beat: null }).headline).toBe('The show is over');
  });
  it.each(['action', 'conversation'] as const)('asks a downed character only for a few words (%s round)', kind => {
    expect(status({ beat: beat({ kind }), name: 'Rook', condition: 'down' })).toEqual({ headline: 'What does Rook say?', detail: 'Type a few words, up to 8, then press Send.', tone: 'act' });
    expect(status({ beat: beat({ kind }), name: 'Rook' }).headline).toBe(kind === 'action' ? 'What does Rook do?' : 'What does Rook say?');
  });
  it('reports a paused table', () => {
    expect(status({ sessionStatus: 'paused' })).toMatchObject({ headline: 'The show is paused', detail: 'Hang on. The director will start again soon.', tone: 'wait' });
  });
  it.each([[null], [beat({ phase: 'published' })], [beat({ phase: 'aborted' })]])('waits for the director when there is no open beat (%#)', current => {
    expect(status({ beat: current })).toMatchObject({ headline: 'Waiting for the next turn', detail: 'You can write now. Your line waits for the next turn.', tone: 'wait' });
  });
  it.each(['queued', 'selected'] as const)('confirms a %s line for the current beat', state => {
    expect(status({ own: [line({ status: state })] })).toMatchObject({ headline: 'The director has your line', detail: 'The director is picking lines. You can still change yours or take it back.', tone: 'done' });
  });
  it.each([[null], [undefined], ['']])('confirms a queued line from between beats (context %j)', ctx => {
    expect(status({ inputEpoch: 1, own: [line({ contextBeatId: ctx as unknown as string })] }).headline).toBe('The director has your line');
  });
  it('does not hold a line from more than four epochs back', () => {
    expect(status({ inputEpoch: 5, own: [line({ contextBeatId: null, inputEpoch: 0 })] })).toMatchObject({ headline: 'What does your character say?', tone: 'act' });
    expect(status({ inputEpoch: 2, beat: beat({ kind: 'action' }), name: 'Lark', own: [line({ contextBeatId: null, inputEpoch: 0 })] }).headline).toBe('What does Lark do?');
  });
  it('holds a line written during the last lock when it fits the open turn', () => {
    expect(status({ inputEpoch: 3, own: [line({ contextBeatId: null, inputEpoch: 1 })] }).headline).toBe('The director has your line');
    expect(status({ inputEpoch: 3, beat: beat({ kind: 'action' }), own: [line({ kind: 'act', text: '', intent: 'Climb up', approach: 'Climb up', contextBeatId: null, inputEpoch: 1 })] }).headline).toBe('The director has your line');
    expect(status({ inputEpoch: 3, own: [line({ kind: 'act', text: '', intent: 'Climb up', approach: 'Climb up', contextBeatId: null, inputEpoch: 1 })] }).headline).toBe('What does your character say?');
  });
  it.each([3, 4])('holds a fitting line the last turn left unpicked (%i epochs back)', back => {
    expect(status({ inputEpoch: 7, own: [line({ contextBeatId: null, inputEpoch: 7 - back })] }).headline).toBe('The director has your line');
    expect(status({ inputEpoch: 7, beat: beat({ kind: 'action' }), name: 'Rook', own: [line({ contextBeatId: null, inputEpoch: 7 - back })] }).headline).toBe('What does Rook do?');
  });
  it('always holds a line the director has picked', () => {
    expect(status({ inputEpoch: 3, beat: beat({ kind: 'action' }), name: 'Rook', own: [line({ status: 'selected', contextBeatId: null, inputEpoch: 1 })] }).headline).toBe('The director has your line');
  });
  it('does not count a null-context line as held when no inputEpoch is given', () => {
    expect(status({ own: [line({ contextBeatId: null, inputEpoch: 0 })] }).headline).toBe('What does your character say?');
  });
  it('does not count a queued private note as a line the director holds', () => {
    expect(status({ own: [line({ kind: 'ooc', text: 'Can I step out?', contextBeatId: null })] })).toMatchObject({ headline: 'What does your character say?', tone: 'act' });
  });
  it('does not count a queued private note for the current beat as a line the director holds', () => {
    expect(status({ own: [line({ kind: 'ooc', text: 'Can I step out?', contextBeatId: 'beat-1' })] })).toMatchObject({ headline: 'What does your character say?', tone: 'act' });
  });
  it('does not count a queued private note in an action round', () => {
    expect(status({ beat: beat({ kind: 'action' }), name: 'Rook', own: [line({ kind: 'ooc', text: 'Can I step out?', contextBeatId: null })] }).headline).toBe('What does Rook do?');
  });
  it('still confirms a real line when a private note is queued too', () => {
    expect(status({ own: [line({ kind: 'ooc', text: 'Can I step out?', contextBeatId: null }), line({ kind: 'say', text: 'Hello', contextBeatId: 'beat-1' })] }).headline).toBe('The director has your line');
  });
  it('treats a withdrawn or locked line as no line sent', () => {
    expect(status({ own: [line({ status: 'withdrawn' as never }), line({ status: 'locked' })] }).headline).toBe('What does your character say?');
  });
  it('ignores lines for another beat and lines that are no longer open', () => {
    expect(status({ own: [line({ contextBeatId: 'beat-0' }), line({ status: 'published' }), line({ status: 'cancelled' })] }).headline).toBe('What does your character say?');
  });
  it('prompts for conversation and action rounds', () => {
    expect(status()).toMatchObject({ headline: 'What does your character say?', detail: 'Type the exact words, then press Send.', tone: 'act' });
    expect(status({ beat: beat({ kind: 'action' }) })).toMatchObject({ headline: 'What does your character do?', detail: 'Describe one thing to try, then press Send. Dice may decide how it goes.', tone: 'act' });
  });
  const stakeWith = (ruling: 'check' | 'no_check' | 'blocked') => ({ ruling }) as PublicBeat['stakes'][number];
  const review = (over: Partial<PublicBeat>) => beat({ phase: 'stakes_review', kind: 'action', ...over });
  const picked = [line({ status: 'selected' })];
  it('says the director is setting the stakes when they are not approved', () => {
    expect(status({ beat: review({ stakesApproved: false }), own: picked })).toEqual({ headline: 'Your line is in this round', detail: 'The director is checking what could happen. If you change your line now, the director has to plan again.', tone: 'done' });
    expect(status({ beat: review({ stakesApproved: false }) })).toEqual({ headline: 'The director is setting the stakes', detail: 'A line you send now waits for the next turn.', tone: 'wait' });
  });
  it('treats missing approval with no stakes as not approved', () => {
    expect(status({ beat: review({ stakes: [] }) }).headline).toBe('The director is setting the stakes');
  });
  it('says the stakes are set when a check is coming', () => {
    const b = review({ stakes: [stakeWith('no_check'), stakeWith('check')], stakesApproved: true });
    expect(status({ beat: b, own: picked })).toEqual({ headline: 'The stakes are set', detail: 'See what is at stake for you below. The dice roll next.', tone: 'wait' });
    expect(status({ beat: b })).toEqual({ headline: 'The stakes are set', detail: 'The dice roll next. A line you send now waits for the next turn.', tone: 'wait' });
  });
  it.each(['no_check', 'blocked'] as const)('says the lines are picked when approved stakes need no roll (%s)', ruling => {
    const b = review({ stakes: [stakeWith(ruling)], stakesApproved: true });
    expect(status({ beat: b, own: picked })).toEqual({ headline: 'The lines are picked', detail: 'The story is written next.', tone: 'wait' });
    expect(status({ beat: b })).toEqual({ headline: 'The lines are picked', detail: 'The story is written next. A line you send now waits for the next turn.', tone: 'wait' });
  });
  it('says the lines are picked for an approved round with no stakes', () => {
    expect(status({ beat: review({ stakes: [], stakesApproved: true, kind: 'conversation' }) }).headline).toBe('The lines are picked');
  });
  it('tells a player with a line in the plan the AI is working', () => {
    expect(status({ beat: beat({ planning: true }), own: picked })).toEqual({ headline: 'Your line is in this round', detail: 'The AI is working out what could happen. This can take a minute.', tone: 'done' });
  });
  it('tells a player with no line in the plan that a new line waits', () => {
    expect(status({ beat: beat({ planning: true }) })).toEqual({ headline: 'This round is being planned', detail: 'A line you send now waits for the next turn.', tone: 'wait' });
    expect(status({ beat: beat({ planning: true }), own: [line({ status: 'queued' })] }).headline).toBe('This round is being planned');
  });
  it.each(['collecting', 'stakes_review'] as const)('never says the director is picking lines while a plan runs (%s)', phase => {
    expect(status({ beat: beat({ phase, planning: true }), own: picked }).detail).not.toMatch(/picking lines/);
    expect(status({ beat: beat({ phase, planning: true }) }).detail).not.toMatch(/picking lines/);
  });
  it('writes locked and draft_review differently', () => {
    expect(status({ beat: beat({ phase: 'locked' }) })).toEqual({ headline: 'Lines locked in. The story is being written', detail: 'The result will appear under The story. New lines wait for the next turn.', tone: 'wait' });
    expect(status({ beat: beat({ phase: 'draft_review' }) })).toEqual({ headline: 'The story is written', detail: 'The director is checking it and getting the voices ready. It will appear under The story.', tone: 'wait' });
  });
  it('says the dice are rolled while locked with a check', () => {
    expect(status({ beat: beat({ phase: 'locked', stakes: [stakeWith('no_check'), stakeWith('check')] }) }).headline).toBe('Dice rolled. The story is being written');
  });
  it('says the story moved on after a publish, voiced or not', () => {
    expect(status({ beat: null, published: { voiced: true } })).toEqual({ headline: 'The story moved on', detail: 'Read the new part under The story, or press Play there to hear it. You can write your next line now.', tone: 'act' });
    expect(status({ beat: beat({ phase: 'published' }), published: { voiced: false } })).toEqual({ headline: 'The story moved on', detail: 'Read the new part under The story. You can write your next line now.', tone: 'act' });
    expect(status({ beat: beat(), published: { voiced: true } }).headline).toBe('What does your character say?');
    expect(status({ beat: null, published: null }).headline).toBe('Waiting for the next turn');
    expect(status({ sessionStatus: 'paused', beat: null, published: { voiced: true } }).headline).toBe('The show is paused');
  });
  it('uses the given name in the prompts', () => {
    expect(status({ name: 'Skooty' }).headline).toBe('What does Skooty say?');
    expect(status({ name: 'Skooty', beat: beat({ kind: 'action' }) }).headline).toBe('What does Skooty do?');
  });
  it('falls back to your character without a name', () => {
    expect(status().headline).toBe('What does your character say?');
    expect(status({ beat: beat({ kind: 'action' }) }).headline).toBe('What does your character do?');
  });
});
