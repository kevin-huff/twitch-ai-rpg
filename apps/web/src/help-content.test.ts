import { describe, expect, it } from 'vitest';
import { firstSteps, topics } from './help/content';

const paragraphs = topics.flatMap((t) =>
  t.sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.steps ?? [])]),
);

describe('help content', () => {
  it('explains the dice moment on stream, its sounds, and the narration waiting for it', () => {
    const stage = topics.find((t) => t.title === 'Stage and OBS')!;
    const dice = stage.sections.find((s) => s.heading === 'The dice on stream');
    expect(dice).toBeDefined();
    const text = (dice!.paragraphs ?? []).join(' ');
    expect(text).toContain('3 to 5 seconds');
    expect(text).toContain('Pieces stay silent');
    expect(text).toContain('A page opened or reloaded after you publish shows the dice strip as usual');
    expect(text).toContain('Until the dice land, the rest of the stream keeps showing what it showed before you published');
    expect(paragraphs.some((p) => p.includes('the narration starts by itself when the dice finish'))).toBe(true);
  });

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
