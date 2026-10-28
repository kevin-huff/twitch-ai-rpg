// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import type { VoiceOption } from '@rpg/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import VoicePicker from './VoicePicker.vue';

const voices: VoiceOption[] = [
  { id: 'eleven:fake-ada', name: 'Ada', group: 'clone', summary: 'female · young · american · bright', previewUrl: 'https://example.invalid/voices/ada.mp3', tuned: true },
  { id: 'eleven:fake-bram', name: 'Bram', group: 'added', summary: 'male · old · irish · raspy', previewUrl: 'https://example.invalid/voices/bram.mp3', tuned: false },
  { id: 'eleven:fake-cyd', name: 'Cyd', group: 'standard', summary: 'neutral · middle aged · british · calm', previewUrl: null, tuned: true },
];
const base = { modelValue: null as string | null, voices, narratorLabel: 'The narrator reads my lines' };

const rows = (w: ReturnType<typeof mount>) => w.findAll('li');
const choose = (w: ReturnType<typeof mount>, index: number) => rows(w)[index].find('.voice-choose');
const sample = (w: ReturnType<typeof mount>, index: number) => rows(w)[index].find('.voice-sample');
const mounted: ReturnType<typeof mount>[] = [];
const mountPicker = (props: Record<string, unknown> = {}, attachTo?: HTMLElement) => {
  const w = mount(VoicePicker, { props: { ...base, ...props }, attachTo });
  mounted.push(w);
  return w;
};

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
});

describe('VoicePicker', () => {
  it('lists the narrator option first, then every voice in the given order', () => {
    const w = mountPicker();
    expect(rows(w)).toHaveLength(4);
    expect(rows(w)[0].find('.voice-name').text()).toBe('The narrator reads my lines');
    expect(rows(w).slice(1).map(row => row.find('.voice-name').text())).toEqual(['Ada', 'Bram', 'Cyd']);
    expect(rows(w)[2].find('.voice-summary').text()).toBe('male · old · irish · raspy');
  });

  it('puts the list in a named box that keyboard users can reach and that keeps the narrator first', () => {
    const w = mountPicker();
    const box = w.get('[data-testid="voice-list"]');
    expect(box.attributes('tabindex')).toBe('0');
    expect(box.attributes('aria-label')).toBe('Voices');
    expect(box.attributes('role')).toBe('group');
    expect(box.findAll('li')[0].attributes('data-testid')).toBe('voice-narrator');
    expect(box.findAll('li')).toHaveLength(4);
  });

  it('uses the narrator label it is given', () => {
    const w = mountPicker({ narratorLabel: 'Narrator' });
    expect(rows(w)[0].find('.voice-name').text()).toBe('Narrator');
  });

  it('marks the narrator for null and for a logical name', () => {
    for (const modelValue of [null, 'narrator', 'voice_narrator']) {
      const w = mountPicker({ modelValue });
      expect(choose(w, 0).attributes('aria-pressed')).toBe('true');
      expect(rows(w)[0].text()).toContain('Chosen');
      expect(w.findAll('[aria-pressed="true"]')).toHaveLength(1);
    }
  });

  it('marks the chosen voice with aria-pressed and a visible Chosen label', () => {
    const w = mountPicker({ modelValue: 'eleven:fake-bram' });
    expect(choose(w, 0).attributes('aria-pressed')).toBe('false');
    expect(rows(w)[0].text()).not.toContain('Chosen');
    expect(choose(w, 2).attributes('aria-pressed')).toBe('true');
    expect(rows(w)[2].find('.voice-chosen').text()).toBe('Chosen');
    expect(w.findAll('.voice-chosen')).toHaveLength(1);
  });

  it('marks nothing for an unlisted eleven: reference', () => {
    const w = mountPicker({ modelValue: 'eleven:gone' });
    expect(w.findAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(w.text()).not.toContain('Chosen');
  });

  it('emits the voice id when a voice is chosen and null for the narrator', async () => {
    const w = mountPicker({ modelValue: 'eleven:fake-ada' });
    await choose(w, 3).trigger('click');
    await choose(w, 0).trigger('click');
    expect(w.emitted('update:modelValue')).toEqual([['eleven:fake-cyd'], [null]]);
  });

  it('shows Tuned for v4 only on tuned voices', () => {
    const w = mountPicker();
    expect(rows(w).map(row => row.text().includes('Tuned for v4'))).toEqual([false, true, false, true]);
  });

  it('shows the reason above the list when it is set', () => {
    const w = mountPicker({ voices: [], reason: 'The voice list is unavailable right now. Everyone keeps the narrator.' });
    expect(w.find('[data-testid="voice-reason"]').text()).toContain('Everyone keeps the narrator');
    expect(w.html().indexOf('voice-reason')).toBeLessThan(w.html().indexOf('<ul'));
    expect(rows(w)).toHaveLength(1);
    expect(mountPicker().find('[data-testid="voice-reason"]').exists()).toBe(false);
  });

  it('disables choosing when disabled', async () => {
    const w = mountPicker({ disabled: true });
    for (let i = 0; i < 4; i += 1) expect(choose(w, i).attributes('disabled')).toBeDefined();
    await choose(w, 1).trigger('click');
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('offers Play sample only for voices with a preview, and loads nothing before Play is pressed', () => {
    const w = mountPicker();
    expect(sample(w, 0).exists()).toBe(false);
    expect(sample(w, 1).text()).toBe('Play sample');
    expect(sample(w, 1).attributes('aria-label')).toBe('Play sample: Ada');
    expect(sample(w, 3).exists()).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('plays one sample at a time across pickers and stops it on Stop', async () => {
    const first = mountPicker();
    const second = mountPicker();
    await sample(first, 1).trigger('click');
    expect(play).toHaveBeenCalledTimes(1);
    expect(sample(first, 1).text()).toBe('Stop sample');
    expect(sample(first, 1).attributes('aria-label')).toBe('Stop sample: Ada');

    await sample(second, 2).trigger('click');
    expect(play).toHaveBeenCalledTimes(2);
    expect(sample(first, 1).text()).toBe('Play sample');
    expect(sample(second, 1).text()).toBe('Play sample');
    expect(sample(second, 2).text()).toBe('Stop sample');

    await sample(second, 2).trigger('click');
    expect(sample(second, 2).text()).toBe('Play sample');
    expect(pause).toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('returns to Play sample when the sample ends', async () => {
    const w = mountPicker();
    await sample(w, 1).trigger('click');
    expect(sample(w, 1).text()).toBe('Stop sample');
    const element = play.mock.contexts[0] as HTMLAudioElement;
    element.dispatchEvent(new Event('ended'));
    await flushPromises();
    expect(sample(w, 1).text()).toBe('Play sample');
  });

  it('returns to Play sample when playback is refused', async () => {
    play.mockImplementationOnce(() => Promise.reject(new Error('blocked')));
    const w = mountPicker();
    await sample(w, 1).trigger('click');
    await flushPromises();
    expect(sample(w, 1).text()).toBe('Play sample');
  });

  it('stops its sample when it unmounts, but leaves another picker\'s sample alone', async () => {
    const first = mountPicker();
    await sample(first, 1).trigger('click');
    const pauses = pause.mock.calls.length;
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);
    expect(pause.mock.calls.length).toBeGreaterThan(pauses);

    const other = mountPicker({ voices: [voices[1]] });
    const third = mountPicker();
    await sample(third, 1).trigger('click');
    const before = pause.mock.calls.length;
    other.unmount();
    mounted.splice(mounted.indexOf(other), 1);
    expect(pause.mock.calls.length).toBe(before);
    expect(sample(third, 1).text()).toBe('Stop sample');
  });

  it('makes every button type=button and never submits a wrapping form', async () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    const Wrapper = defineComponent({
      render: () => h('form', { onSubmit }, [h(VoicePicker, { ...base, modelValue: 'eleven:fake-ada' })]),
    });
    const w = mount(Wrapper, { attachTo: document.body });
    mounted.push(w as unknown as ReturnType<typeof mount>);
    const buttons = w.findAll('button');
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.attributes('type')).toBe('button');
      await button.trigger('click');
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
