// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StrainMeter, { strainWord } from './StrainMeter.vue';

const draw = (props: Record<string, unknown>) => mount(StrainMeter, { props: props as never });
const text = (w: ReturnType<typeof draw>) => w.get('[data-testid="strain-meter-text"]').text();

describe('StrainMeter', () => {
  it.each([4, 8, 12])('draws %i notches and fills the value', max => {
    const w = draw({ value: 3, max });
    expect(w.findAll('.notch')).toHaveLength(max);
    expect(w.findAll('.notch.filled')).toHaveLength(3);
    expect(text(w)).toBe(`Strain 3 of ${max}`);
    expect((w.get('.notches').element as HTMLElement).style.gridTemplateColumns).toBe(`repeat(${max}, 1fr)`);
  });

  it('says Spent only at the maximum', () => {
    for (const max of [4, 8, 12]) {
      expect(text(draw({ value: max - 1, max }))).not.toContain('Spent');
      expect(text(draw({ value: max, max }))).toBe(`Strain ${max} of ${max} · Spent`);
    }
  });

  it('reads Fresh, Worn and Spent at the thresholds', () => {
    const expected: Record<number, string> = { 0: 'Fresh', 3: 'Fresh', 4: 'Worn', 7: 'Worn', 8: 'Spent' };
    for (const [value, word] of Object.entries(expected)) {
      expect(strainWord(Number(value), 8)).toBe(word);
      expect(text(draw({ value: Number(value), max: 8, words: true }))).toBe(word);
    }
  });

  it('clamps out-of-range values', () => {
    expect(text(draw({ value: -1, max: 8 }))).toBe('Strain 0 of 8');
    expect(text(draw({ value: 9, max: 8 }))).toBe('Strain 8 of 8 · Spent');
    expect(draw({ value: 1, max: 0 }).findAll('.notch')).toHaveLength(1);
  });

  it('sets meter role and aria values', () => {
    const w = draw({ value: 5, max: 8, label: 'Scrot strain' });
    const root = w.get('[data-testid="strain-meter"]');
    expect(root.attributes('role')).toBe('meter');
    expect(root.attributes('aria-valuemin')).toBe('0');
    expect(root.attributes('aria-valuemax')).toBe('8');
    expect(root.attributes('aria-valuenow')).toBe('5');
    expect(root.attributes('aria-label')).toBe('Scrot strain');
    expect(root.attributes('aria-valuetext')).toBe('Scrot strain 5 of 8');
    expect(draw({ value: 5, max: 8, words: true }).get('[role="meter"]').attributes('aria-valuetext')).toBe('Worn, 5 of 8');
  });
});
