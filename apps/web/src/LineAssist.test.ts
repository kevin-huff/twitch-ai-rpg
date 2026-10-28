// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

const lineAssist = vi.fn();
vi.mock('./api', () => ({ api: { lineAssist: (...args: unknown[]) => lineAssist(...args) } }));

import LineAssist from './LineAssist.vue';

const props = { sessionId: 's1', idea: 'tell him no', recipientNpcIds: ['n1'], canSend: true };
const ask = (w: ReturnType<typeof mount>) => w.find('.line-assist-ask');

beforeEach(() => lineAssist.mockReset());

describe('LineAssist', () => {
  it('is disabled for a blank idea and when sending is not allowed', () => {
    expect(ask(mount(LineAssist, { props: { ...props, idea: '   ' } })).attributes('disabled')).toBeDefined();
    expect(ask(mount(LineAssist, { props: { ...props, canSend: false } })).attributes('disabled')).toBeDefined();
    const ready = ask(mount(LineAssist, { props }));
    expect(ready.attributes('disabled')).toBeUndefined();
    expect(ready.text()).toBe('Help me say it');
  });

  it('reads Writing… and is disabled while the request runs', async () => {
    let finish: (value: { text: string }) => void = () => undefined;
    lineAssist.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    expect(ask(w).text()).toBe('Writing…');
    expect(ask(w).attributes('disabled')).toBeDefined();
    expect(lineAssist).toHaveBeenCalledWith('s1', { idea: 'tell him no', recipientNpcIds: ['n1'] });
    finish({ text: 'No.' });
    await flushPromises();
    expect(ask(w).text()).toBe('Help me say it');
  });

  it('shows the suggestion with three buttons and Use this only emits the text', async () => {
    lineAssist.mockResolvedValue({ text: '[warmly] No.\nReally.' });
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    await flushPromises();
    expect(w.find('.line-assist-text').text()).toContain('[warmly] No.');
    expect(w.findAll('.line-assist-actions button').map(b => b.text())).toEqual(['Use this', 'Try again', 'Keep mine']);
    await w.find('[data-testid="line-assist-use"]').trigger('click');
    expect(w.emitted('use')).toEqual([['[warmly] No.\nReally.']]);
    expect(w.find('[data-testid="line-assist-suggestion"]').exists()).toBe(false);
  });

  it('Try again asks again and Keep mine closes', async () => {
    lineAssist.mockResolvedValueOnce({ text: 'One' }).mockResolvedValueOnce({ text: 'Two' });
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    await flushPromises();
    await w.find('[data-testid="line-assist-retry"]').trigger('click');
    await flushPromises();
    expect(lineAssist).toHaveBeenCalledTimes(2);
    expect(w.find('.line-assist-text').text()).toBe('Two');
    await w.find('[data-testid="line-assist-keep"]').trigger('click');
    expect(w.find('[data-testid="line-assist-suggestion"]').exists()).toBe(false);
    expect(w.emitted('use')).toBeUndefined();
  });

  it('shows the failure message and emits nothing', async () => {
    lineAssist.mockRejectedValueOnce(new Error('Already writing a suggestion.'));
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    await flushPromises();
    expect(w.find('[role="status"]').text()).toBe('Already writing a suggestion.');
    lineAssist.mockRejectedValueOnce('boom');
    await ask(w).trigger('click');
    await flushPromises();
    expect(w.find('[role="status"]').text()).toBe('The AI could not help this time. Your words are unchanged.');
    expect(w.emitted('use')).toBeUndefined();
    expect(w.find('[data-testid="line-assist-suggestion"]').exists()).toBe(false);
  });

  it('clears the suggestion when the words box is emptied', async () => {
    lineAssist.mockResolvedValue({ text: 'No.' });
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="line-assist-use"]').exists()).toBe(true);
    await w.setProps({ idea: '' });
    expect(w.find('[data-testid="line-assist-suggestion"]').exists()).toBe(false);
    expect(w.find('[data-testid="line-assist-use"]').exists()).toBe(false);
  });

  it('discards a reply that lands after the words box was emptied', async () => {
    let finish: (value: { text: string }) => void = () => undefined;
    lineAssist.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const w = mount(LineAssist, { props });
    await ask(w).trigger('click');
    await w.setProps({ idea: '' });
    finish({ text: 'Late.' });
    await flushPromises();
    expect(w.find('[data-testid="line-assist-suggestion"]').exists()).toBe(false);
    expect(ask(w).text()).toBe('Help me say it');
  });

  it('never submits a surrounding form', async () => {
    lineAssist.mockResolvedValue({ text: 'Hello' });
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    const Host = defineComponent({ render: () => h('form', { onSubmit }, [h(LineAssist, props)]) });
    const w = mount(Host, { attachTo: document.body });
    await w.find('.line-assist-ask').trigger('click');
    await flushPromises();
    for (const id of ['retry', 'keep']) {
      await w.find(`[data-testid="line-assist-${id}"]`).trigger('click');
      await flushPromises();
    }
    await w.find('.line-assist-ask').trigger('click');
    await flushPromises();
    await w.find('[data-testid="line-assist-use"]').trigger('click');
    expect(w.findAll('button').every(b => b.attributes('type') === 'button')).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    w.unmount();
  });
});
