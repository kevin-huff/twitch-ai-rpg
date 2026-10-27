import { describe, expect, it } from 'vitest';
import { firstSteps, topics } from './help/content';

const paragraphs = topics.flatMap((t) =>
  t.sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.steps ?? [])]),
);

describe('help content', () => {
  it('tells players to press Save my card in step 2', () => {
    expect(firstSteps.player[1]).toContain('Save my card');
  });

  it('never says a note clears nothing', () => {
    expect(paragraphs.filter((p) => p.includes('clears nothing'))).toEqual([]);
  });

  it('says the Note for the AI throws away the draft', () => {
    const p = paragraphs.find((x) => x.startsWith('Note for the AI, in Show tools'));
    expect(p).toBeDefined();
    expect(p).toContain('draft');
  });

  it('does not put Audio options inside Show all', () => {
    expect(paragraphs.filter((p) => /Audio options inside it/.test(p))).toEqual([]);
    const p = paragraphs.find((x) => x.includes('Show all opens that beat'));
    expect(p).toContain('Preview (not for OBS)');
  });
});
