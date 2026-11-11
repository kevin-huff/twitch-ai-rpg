import { describe, expect, it } from 'vitest';
import { downNote } from './down-note';

const base = 'Rook is down. You can say a few words, up to 8.';

describe('downNote', () => {
  it('says someone can save the character in the next round when no round is open', () => {
    expect(downNote({ name: 'Rook', characterId: 'pc-1', beat: null })).toBe(`${base} Someone can still save Rook in the next round. If nobody does, one last-chance roll decides: 7 or more on two dice and Rook pulls through; 6 or less, or double 1s, and Rook dies.`);
  });

  it.each(['collecting', 'stakes_review'])('says someone can save the character in this round while the round is %s', phase => {
    expect(downNote({ name: 'Rook', characterId: 'pc-1', beat: { phase, lastChanceFor: [] } })).toBe(`${base} Someone can still save Rook in this round. If nobody does, one last-chance roll decides when the dice are rolled: 7 or more on two dice and Rook pulls through; 6 or less, or double 1s, and Rook dies.`);
  });

  it.each(['locked', 'draft_review'])('says only that the dice are rolled once they are, giving away neither a rescue nor a last chance (%s)', phase => {
    const note = downNote({ name: 'Rook', characterId: 'pc-1', beat: { phase, lastChanceFor: ['pc-1'] } });
    expect(note).toBe(`${base} The dice are rolled. The story will tell what happens to Rook.`);
    expect(note).not.toMatch(/saved|last chance|pulls through|dies/);
  });

  it.each(['locked', 'draft_review'])('says a part of the story with no dice leaves the rescue open for the next round (%s)', phase => {
    expect(downNote({ name: 'Rook', characterId: 'pc-1', beat: { phase, lastChanceFor: [] } })).toBe(`${base} This part of the story has no dice, so someone can still save Rook in the next round. If nobody does, one last-chance roll decides: 7 or more on two dice and Rook pulls through; 6 or less, or double 1s, and Rook dies.`);
    expect(downNote({ name: 'Rook', characterId: 'pc-1', beat: { phase, lastChanceFor: undefined } })).toBe(`${base} The next part of the story is being written.`);
  });

  it('treats a published or aborted round as no open round', () => {
    expect(downNote({ name: 'Rook', characterId: 'pc-1', beat: { phase: 'published' } })).toContain('in the next round');
  });
});
