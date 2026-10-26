// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StageFrame from './StageFrame.vue';
import StageSlate from './StageSlate.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('stage-transparent');
});

function stubObserver(width: number, height: number) {
  const disconnect = vi.fn();
  class FakeObserver {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width, height } }]); }
    disconnect = disconnect;
  }
  vi.stubGlobal('ResizeObserver', FakeObserver);
  return disconnect;
}

describe('StageFrame', () => {
  it('scales the 1920x1080 canvas to the measured box', async () => {
    const disconnect = stubObserver(1280, 720);
    const wrapper = mount(StageFrame, { props: { layout: 'scene' }, slots: { default: '<p>hi</p>' } });
    await nextTick();
    const canvas = wrapper.get('.stage-canvas');
    const style = canvas.attributes('style') ?? '';
    expect(style).toContain('width: 1920px');
    expect(style).toContain('height: 1080px');
    const match = /scale\(([\d.]+)\)/.exec(style);
    expect(Number(match?.[1])).toBeCloseTo(2 / 3, 5);
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['stage', 'stage-frame']));
    expect(wrapper.text()).toContain('hi');
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('falls back to the window size without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    window.innerWidth = 960;
    window.innerHeight = 540;
    const wrapper = mount(StageFrame, { props: { layout: 'scene' } });
    await nextTick();
    const match = /scale\(([\d.]+)\)/.exec(wrapper.get('.stage-canvas').attributes('style') ?? '');
    expect(Number(match?.[1])).toBeCloseTo(0.5, 5);
    wrapper.unmount();
  });

  it('makes the page transparent only while the overlay is mounted', () => {
    stubObserver(1920, 1080);
    const wrapper = mount(StageFrame, { props: { layout: 'overlay' } });
    expect(document.documentElement.classList.contains('stage-transparent')).toBe(true);
    wrapper.unmount();
    expect(document.documentElement.classList.contains('stage-transparent')).toBe(false);
  });

  it('leaves the page alone for the scene layout', () => {
    stubObserver(1920, 1080);
    const wrapper = mount(StageFrame, { props: { layout: 'scene' } });
    expect(document.documentElement.classList.contains('stage-transparent')).toBe(false);
    wrapper.unmount();
  });

  it('draws a checkerboard when asked', () => {
    stubObserver(1920, 1080);
    expect(mount(StageFrame, { props: { layout: 'overlay', checker: true } }).find('.stage-checker').exists()).toBe(true);
    expect(mount(StageFrame, { props: { layout: 'overlay' } }).find('.stage-checker').exists()).toBe(false);
  });
});

describe('StageSlate', () => {
  const base = { showTitle: 'The Lantern Road', sceneTitle: 'The Harbor', sceneDescription: 'Fog rolls in.' };

  it.each([
    ['lobby', 'Starting soon'],
    ['paused', 'right back'],
    ['ended', 'Thanks for watching'],
    ['offline', 'The story continues shortly'],
    ['waiting', 'The Harbor']
  ] as const)('shows the %s text', (kind, text) => {
    const wrapper = mount(StageSlate, { props: { ...base, kind } });
    expect(wrapper.text()).toContain(text);
  });

  it('shows the scene title when paused and the description when waiting', () => {
    expect(mount(StageSlate, { props: { ...base, kind: 'paused' } }).text()).toContain('The Harbor');
    expect(mount(StageSlate, { props: { ...base, kind: 'waiting' } }).text()).toContain('Fog rolls in.');
  });

  it('applies the compact class', () => {
    expect(mount(StageSlate, { props: { ...base, kind: 'lobby', compact: true } }).classes()).toContain('compact');
    expect(mount(StageSlate, { props: { ...base, kind: 'lobby' } }).classes()).not.toContain('compact');
  });

  it('renders no interactive elements', () => {
    stubObserver(1920, 1080);
    const wrapper = mount(StageFrame, { props: { layout: 'scene' }, slots: { default: StageSlate as never } });
    expect(wrapper.find('button, input, select, textarea, img, a').exists()).toBe(false);
    const slate = mount(StageSlate, { props: { ...base, kind: 'paused' } });
    expect(slate.find('button, input, select, textarea, img, a').exists()).toBe(false);
  });
});
