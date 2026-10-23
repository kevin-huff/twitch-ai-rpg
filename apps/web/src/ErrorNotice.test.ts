// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorNotice from './ErrorNotice.vue';

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('persistent error notice', () => {
  it('announces escaped error text without moving focus or disappearing on a timer', async () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.append(input); input.focus();
    const wrapper = mount(ErrorNotice, { props: { message: '<img src=x onerror=alert(1)> Could not save.' }, attachTo: document.body });
    expect(wrapper.get('[role="alert"]').text()).toContain('<img src=x onerror=alert(1)> Could not save.');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(document.activeElement).toBe(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper.get('[role="alert"]').isVisible()).toBe(true);
    expect(wrapper.emitted('dismiss')).toBeUndefined();
    wrapper.unmount();
  });

  it('emits dismissal without submitting a containing form and displays replacement errors', async () => {
    const wrapper = mount(ErrorNotice, { props: { message: 'Could not save.' } });
    const dismiss = wrapper.get('button[aria-label="Dismiss error"]');
    expect(dismiss.attributes('type')).toBe('button');
    await dismiss.trigger('click');
    expect(wrapper.emitted('dismiss')).toEqual([[]]);
    await wrapper.setProps({ message: 'Please correct the character traits.' });
    expect(wrapper.get('[role="alert"]').text()).toContain('Please correct the character traits.');
    expect(wrapper.text()).not.toContain('Could not save.');
    wrapper.unmount();
  });

  it('keeps the supplied recovery action available', async () => {
    const retry = vi.fn();
    const wrapper = mount(ErrorNotice, {
      props: { message: 'Could not connect.' },
      slots: { default: '<button type="button" class="retry">Refresh state</button>' },
    });
    wrapper.get('.retry').element.addEventListener('click', retry);
    await wrapper.get('.retry').trigger('click');
    expect(retry).toHaveBeenCalledOnce();
    expect(wrapper.emitted('dismiss')).toBeUndefined();
    wrapper.unmount();
  });
});
