// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PixelDie from './PixelDie.vue';

describe('PixelDie', () => {
  it('lights the right pips for faces 1 to 6', () => {
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const die = mount(PixelDie, { props: { face, sprite: 'face', size: 64 } });
      expect(die.findAll('.pip')).toHaveLength(face);
      expect(die.get('.pixel-die').attributes('data-face')).toBe(String(face));
    }
  });

  it('marks sprite, variant and size', () => {
    const die = mount(PixelDie, { props: { face: 3, sprite: 'edge', size: 48, variant: 'crit' } });
    const root = die.get('.pixel-die');
    expect(root.attributes('data-sprite')).toBe('edge');
    expect(root.attributes('data-variant')).toBe('crit');
    expect(root.attributes('style')).toContain('width: 48px');
    expect(root.attributes('style')).toContain('height: 48px');
  });

  it('defaults to a plain die', () => {
    expect(mount(PixelDie, { props: { face: 2, sprite: 'face', size: 40 } }).get('.pixel-die').attributes('data-variant')).toBe('plain');
  });

  it('draws the corner sprite as a stepped diamond', () => {
    const die = mount(PixelDie, { props: { face: 4, sprite: 'corner', size: 48 } });
    const shapes = die.findAll('.die-diamond');
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) expect(shape.attributes('style')).toMatch(/--die-shape: polygon\(/);
  });

  it('cracks a critical die and squashes on a landing frame', () => {
    const die = mount(PixelDie, { props: { face: 1, sprite: 'face', size: 64, variant: 'crit', squash: true } });
    expect(die.find('.die-crack').exists()).toBe(true);
    expect(die.get('.pixel-die').classes()).toContain('squash');
    expect(mount(PixelDie, { props: { face: 1, sprite: 'face', size: 64 } }).find('.die-crack').exists()).toBe(false);
  });
});
