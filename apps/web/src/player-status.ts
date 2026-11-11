import { DOWNED_SAY_WORDS, type CharacterCondition, type PublicBeat, type Submission } from '@rpg/contracts';

export type PlayerStatus = { headline: string; detail: string; tone: 'wait' | 'act' | 'done' };

export function playerStatus(input: { sessionStatus: string; beat: PublicBeat | null; own: Submission[]; name?: string; inputEpoch?: number; condition?: CharacterCondition; published?: { voiced: boolean } | null }): PlayerStatus {
  const { sessionStatus, beat, own, inputEpoch } = input;
  const name = input.name ?? 'your character';
  if (sessionStatus === 'ended') return { headline: 'The show is over', detail: 'Thanks for playing. You can close this page.', tone: 'wait' };
  if (sessionStatus === 'paused') return { headline: 'The show is paused', detail: 'Hang on. The director will start again soon.', tone: 'wait' };
  const closed = !beat || beat.phase === 'published' || beat.phase === 'aborted';
  if (closed && input.published) return { headline: 'The story moved on', detail: input.published.voiced ? 'Read the new part under The story, or press Play there to hear it. You can write your next line now.' : 'Read the new part under The story. You can write your next line now.', tone: 'act' };
  if (!beat || closed) return { headline: 'Waiting for the next turn', detail: 'You can write now. Your line waits for the next turn.', tone: 'wait' };
  // Each turn moves the epoch on by two (publish or abort, then open). A line with no beat is one back when written
  // between turns, two back when written during the last lock, and two to four back when the last turn left it
  // unpicked. The server marks those alike, so beyond one back a line counts only when it fits this turn, and
  // nothing older than four back counts, so a line skipped turn after turn stops holding the banner.
  const fits = (item: Submission) => (item.kind === 'act') === (beat.kind === 'action');
  const waiting = (item: Submission) => !item.contextBeatId && inputEpoch !== undefined && (item.inputEpoch === inputEpoch - 1 || (item.inputEpoch <= inputEpoch - 2 && item.inputEpoch >= inputEpoch - 4 && fits(item)));
  const picked = own.some(item => item.kind !== 'ooc' && item.status === 'selected');
  if (beat.planning) {
    return picked
      ? { headline: 'Your line is in this round', detail: 'The AI is working out what could happen. This can take a minute.', tone: 'done' }
      : { headline: 'This round is being planned', detail: 'A line you send now waits for the next turn.', tone: 'wait' };
  }
  if (beat.phase === 'collecting' && own.some(item => item.kind !== 'ooc' && (item.status === 'selected' || (item.status === 'queued' && (item.contextBeatId === beat.id || waiting(item)))))) return { headline: 'The director has your line', detail: 'The director is picking lines. You can still change yours or take it back.', tone: 'done' };
  if (beat.phase === 'collecting') {
    if (input.condition === 'down') return { headline: `What does ${name} say?`, detail: `Type a few words, up to ${DOWNED_SAY_WORDS}, then press Send.`, tone: 'act' };
    return beat.kind === 'action'
      ? { headline: `What does ${name} do?`, detail: 'Describe one thing to try, then press Send. Dice may decide how it goes.', tone: 'act' }
      : { headline: `What does ${name} say?`, detail: 'Type the exact words, then press Send.', tone: 'act' };
  }
  if (beat.phase === 'stakes_review') {
    const approved = beat.stakesApproved ?? beat.stakes.length > 0;
    const next = ' A line you send now waits for the next turn.';
    if (!approved) {
      return picked
        ? { headline: 'Your line is in this round', detail: 'The director is checking what could happen. If you change your line now, the director has to plan again.', tone: 'done' }
        : { headline: 'The director is setting the stakes', detail: next.trim(), tone: 'wait' };
    }
    if (beat.stakes.some(stake => stake.ruling === 'check')) {
      return picked
        ? { headline: 'The stakes are set', detail: 'See what is at stake for you below. The dice roll next.', tone: 'wait' }
        : { headline: 'The stakes are set', detail: `The dice roll next.${next}`, tone: 'wait' };
    }
    return { headline: 'The lines are picked', detail: `The story is written next.${picked ? '' : next}`, tone: 'wait' };
  }
  if (beat.phase === 'draft_review') return { headline: 'The story is written', detail: 'The director is checking it and getting the voices ready. It will appear under The story.', tone: 'wait' };
  const rolled = beat.stakes.some(stake => stake.ruling === 'check');
  return { headline: rolled ? 'Dice rolled. The story is being written' : 'Lines locked in. The story is being written', detail: 'The result will appear under The story. New lines wait for the next turn.', tone: 'wait' };
}
