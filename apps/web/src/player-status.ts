import type { PublicBeat, Submission } from '@rpg/contracts';

export type PlayerStatus = { headline: string; detail: string; tone: 'wait' | 'act' | 'done' };

export function playerStatus(input: { sessionStatus: string; beat: PublicBeat | null; own: Submission[]; name?: string; inputEpoch?: number }): PlayerStatus {
  const { sessionStatus, beat, own, inputEpoch } = input;
  const name = input.name ?? 'your character';
  if (sessionStatus === 'ended') return { headline: 'The show is over', detail: 'Thanks for playing. You can close this page.', tone: 'wait' };
  if (sessionStatus === 'paused') return { headline: 'The show is paused', detail: 'Hang on. The director will start again soon.', tone: 'wait' };
  if (!beat || beat.phase === 'published' || beat.phase === 'aborted') return { headline: 'Waiting for the next turn', detail: 'You can write now. Your line waits for the next turn.', tone: 'wait' };
  // Each turn moves the epoch on by two (publish or abort, then open). A line with no beat is one back when written
  // between turns, two back when written during the last lock, and two to four back when the last turn left it
  // unpicked. The server marks those alike, so beyond one back a line counts only when it fits this turn, and
  // nothing older than four back counts, so a line skipped turn after turn stops holding the banner.
  const fits = (item: Submission) => (item.kind === 'act') === (beat.kind === 'action');
  const waiting = (item: Submission) => !item.contextBeatId && inputEpoch !== undefined && (item.inputEpoch === inputEpoch - 1 || (item.inputEpoch <= inputEpoch - 2 && item.inputEpoch >= inputEpoch - 4 && fits(item)));
  if (beat.phase === 'collecting' && own.some(item => item.kind !== 'ooc' && (item.status === 'selected' || (item.status === 'queued' && (item.contextBeatId === beat.id || waiting(item)))))) return { headline: 'The director has your line', detail: 'The director is picking lines. You can still change yours or take it back.', tone: 'done' };
  if (beat.phase === 'collecting') {
    return beat.kind === 'action'
      ? { headline: `What does ${name} do?`, detail: 'Describe one thing to try, then press Send. Dice may decide how it goes.', tone: 'act' }
      : { headline: `What does ${name} say?`, detail: 'Type the exact words, then press Send.', tone: 'act' };
  }
  if (beat.phase === 'stakes_review') {
    return beat.kind === 'action'
      ? { headline: 'Getting the dice ready', detail: 'The director is deciding what could happen. You can still change your line until it is locked in.', tone: 'wait' }
      : { headline: 'The director is checking the lines', detail: 'You can still change your line until it is locked in.', tone: 'wait' };
  }
  const rolled = beat.kind === 'action' && beat.stakes.some(stake => stake.ruling === 'check');
  return { headline: rolled ? 'Dice rolled. The story is being written' : 'Lines locked in. The story is being written', detail: 'Watch the stream. New lines wait for the next turn.', tone: 'wait' };
}
