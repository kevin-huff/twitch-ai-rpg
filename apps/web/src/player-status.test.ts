import { describe, expect, it } from 'vitest';
import type { PublicBeat, Submission } from '@rpg/contracts';
import { playerStatus } from './player-status';

const beat = (over: Partial<PublicBeat> = {}): PublicBeat => ({ id: 'beat-1', kind: 'conversation', phase: 'collecting', revision: 1, stakes: [], locked: false, ...over });
const line = (over: Partial<Submission> = {}): Submission => ({ id: 's1', sessionId: 'show', characterId: 'pc-1', contextBeatId: 'beat-1', inputEpoch: 0, revision: 1, kind: 'say', text: 'Hello', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'queued', ...over });
const status = (over: Partial<Parameters<typeof playerStatus>[0]> = {}) => playerStatus({ sessionStatus: 'live', ready: true, beat: beat(), own: [], ...over });

describe('playerStatus', () => {
  it('asks for setup first, ahead of everything else', () => {
    expect(status({ ready: false, sessionStatus: 'paused', beat: null })).toEqual({ headline: 'Finish setup first', detail: 'Open Cast & lobby, read your character card, tick the box and press Mark ready. You can still send the director a private note.', tone: 'act' });
  });
  it('ends the show ahead of everything else', () => {
    expect(status({ sessionStatus: 'ended', ready: false })).toEqual({ headline: 'The show is over', detail: 'Thanks for playing. You can close this page.', tone: 'wait' });
    expect(status({ sessionStatus: 'ended', beat: null }).headline).toBe('The show is over');
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
  it('explains the stakes review, even when a line was selected', () => {
    expect(status({ beat: beat({ phase: 'stakes_review' }), own: [line({ status: 'selected' })] })).toMatchObject({ headline: 'The director is checking the lines', detail: 'You can still change your line until it is locked in.', tone: 'wait' });
    expect(status({ beat: beat({ phase: 'stakes_review', kind: 'action' }), own: [line({ status: 'selected' })] })).toMatchObject({ headline: 'Getting the dice ready', detail: 'The director is deciding what could happen. You can still change your line until it is locked in.', tone: 'wait' });
  });
  it.each(['locked', 'draft_review'] as const)('says a conversation is locked, without dice, while %s', phase => {
    expect(status({ beat: beat({ phase }), own: [line({ status: 'locked' })] })).toMatchObject({ headline: 'Lines locked in. The story is being written', detail: 'Watch the stream. New lines wait for the next turn.', tone: 'wait' });
  });
  const stakeWith = (ruling: 'check' | 'no_check' | 'blocked') => ({ ruling }) as PublicBeat['stakes'][number];
  it.each(['locked', 'draft_review'] as const)('says the dice are rolled for an action round with a check while %s', phase => {
    expect(status({ beat: beat({ phase, kind: 'action', stakes: [stakeWith('no_check'), stakeWith('check')] }) }).headline).toBe('Dice rolled. The story is being written');
  });
  it('does not mention dice when no action in the round needs a roll', () => {
    expect(status({ beat: beat({ phase: 'locked', kind: 'action', stakes: [stakeWith('no_check'), stakeWith('blocked')] }) }).headline).toBe('Lines locked in. The story is being written');
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
