// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PictureIdResponse, PortraitDetails } from '@rpg/contracts';
import PortraitGenerator from './PortraitGenerator.vue';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const details: PortraitDetails = { appearance: 'A tall woman in a grey coat.', role: 'Records', pronouns: 'she/her', name: 'Mara Quill' };
const t = (name: string) => `[data-testid="portrait-${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];
function setup(props: Record<string, unknown> = {}) {
  const generate = vi.fn<(details: PortraitDetails) => Promise<PictureIdResponse>>().mockResolvedValue({ imageId: ID_A });
  const wrapper = mount(PortraitGenerator, {
    props: { name: 'Mara Quill', details, contextKey: 'a', imageUrl: (id: string) => `/img/${id}`, generate, ...props },
  });
  wrappers.push(wrapper);
  return { wrapper, generate };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('portrait generator', () => {
  it('shows a placeholder with initials, the help text and only a Create portrait button at first', () => {
    const { wrapper } = setup();
    expect(wrapper.get(t('create')).text()).toBe('Create portrait');
    expect(wrapper.get(t('create')).attributes('disabled')).toBeUndefined();
    expect(wrapper.find(t('remove')).exists()).toBe(false);
    expect(wrapper.find(t('current')).exists()).toBe(false);
    expect(wrapper.get(t('placeholder')).text()).toBe('MQ');
    expect(wrapper.text()).toContain('Press Create portrait to draw this character from the Appearance, Specialty and Pronouns boxes. The name and the secret never go to the picture service. The portrait goes on the card when you press Use this portrait, and it is saved with the rest of the card.');
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('label').exists()).toBe(false);
  });

  it('shows the current portrait at 96px with its alt text and a Remove portrait button that emits remove', async () => {
    const { wrapper } = setup({ portraitId: ID_A });
    const image = wrapper.get(t('current'));
    expect(image.attributes('src')).toBe(`/img/${ID_A}`);
    expect(image.attributes('alt')).toBe('Portrait of Mara Quill');
    expect(image.attributes('width')).toBe('96');
    await wrapper.get(t('remove')).trigger('click');
    expect(wrapper.emitted('remove')).toHaveLength(1);
  });

  it('falls back to initials when the current image fails to load', async () => {
    const { wrapper } = setup({ portraitId: ID_A });
    await wrapper.get(t('current')).trigger('error');
    expect(wrapper.find(t('current')).exists()).toBe(false);
    expect(wrapper.get(t('placeholder')).text()).toBe('MQ');
    expect(wrapper.find(t('remove')).exists()).toBe(true);
  });

  it('sends the details, shows a disabled busy button while pending, then a 160px preview', async () => {
    const { wrapper, generate } = setup();
    const answer = deferred<PictureIdResponse>();
    generate.mockReturnValueOnce(answer.promise);
    await wrapper.get(t('create')).trigger('click');
    expect(generate).toHaveBeenCalledWith(details);
    expect(wrapper.get(t('create')).text()).toBe('Making the portrait...');
    expect(wrapper.get(t('create')).attributes('disabled')).toBeDefined();
    expect(wrapper.get('.portrait-generator').attributes('aria-busy')).toBe('true');
    answer.resolve({ imageId: ID_B });
    await flushPromises();
    const preview = wrapper.get(t('preview'));
    expect(preview.attributes('src')).toBe(`/img/${ID_B}`);
    expect(preview.attributes('alt')).toBe('Portrait of Mara Quill');
    expect(preview.attributes('width')).toBe('160');
    expect(wrapper.get('.portrait-generator').attributes('aria-busy')).toBe('false');
    expect(wrapper.get(t('use')).text()).toBe('Use this portrait');
    expect(wrapper.get(t('retry')).text()).toBe('Try again');
    expect(wrapper.get(t('cancel')).text()).toBe('Cancel');
  });

  it('emits use with the new id and closes the preview', async () => {
    const { wrapper } = setup();
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    await wrapper.get(t('use')).trigger('click');
    expect(wrapper.emitted('use')).toEqual([[ID_A]]);
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.get(t('create')).text()).toBe('Create portrait');
  });

  it('asks again on Try again and replaces the preview', async () => {
    const { wrapper, generate } = setup();
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    generate.mockResolvedValueOnce({ imageId: ID_B });
    await wrapper.get(t('retry')).trigger('click');
    await flushPromises();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(wrapper.get(t('preview')).attributes('src')).toBe(`/img/${ID_B}`);
    expect(wrapper.emitted('use')).toBeUndefined();
  });

  it('discards the preview on Cancel without emitting anything', async () => {
    const { wrapper } = setup();
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    await wrapper.get(t('cancel')).trigger('click');
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.emitted('use')).toBeUndefined();
    expect(wrapper.emitted('remove')).toBeUndefined();
  });

  it('shows the server message in an alert and turns the main button into Try again', async () => {
    const { wrapper, generate } = setup();
    generate.mockRejectedValueOnce(new Error('Pictures are off on this server.'));
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    const notice = wrapper.get('p.notice.error');
    expect(notice.text()).toBe('Pictures are off on this server.');
    expect(notice.attributes('role')).toBe('alert');
    expect(wrapper.get(t('create')).text()).toBe('Try again');
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    expect(wrapper.find('p.notice.error').exists()).toBe(false);
    expect(wrapper.find(t('preview')).exists()).toBe(true);
  });

  it('uses the default error sentence when the failure has no message', async () => {
    const { wrapper, generate } = setup();
    generate.mockRejectedValueOnce('nope');
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    expect(wrapper.get('p.notice.error').text()).toBe('The portrait could not be made. Press Try again.');
  });

  it('sets a pending or shown result aside when the context changes', async () => {
    const { wrapper, generate } = setup();
    await wrapper.get(t('create')).trigger('click');
    await flushPromises();
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.get('p.notice').text()).toBe('Something on this page changed, so that portrait was set aside. Press Create portrait again.');

    const answer = deferred<PictureIdResponse>();
    generate.mockReturnValueOnce(answer.promise);
    await wrapper.get(t('create')).trigger('click');
    expect(wrapper.find('p.notice').exists()).toBe(false);
    await wrapper.setProps({ contextKey: 'c' });
    expect(wrapper.get(t('create')).text()).toBe('Create portrait');
    expect(wrapper.get('p.notice').text()).toContain('set aside');
  });

  it('says nothing when the context changes with nothing in progress', async () => {
    const { wrapper } = setup();
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.find('p.notice').exists()).toBe(false);
  });

  it('ignores an answer that arrives after the context changed or a newer request started', async () => {
    const { wrapper, generate } = setup();
    const first = deferred<PictureIdResponse>();
    generate.mockReturnValueOnce(first.promise);
    await wrapper.get(t('create')).trigger('click');
    await wrapper.setProps({ contextKey: 'b' });
    first.resolve({ imageId: ID_A });
    await flushPromises();
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.emitted('use')).toBeUndefined();

    const second = deferred<PictureIdResponse>();
    const third = deferred<PictureIdResponse>();
    generate.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    await wrapper.get(t('create')).trigger('click');
    await wrapper.setProps({ contextKey: 'c' });
    await wrapper.get(t('create')).trigger('click');
    third.resolve({ imageId: ID_B });
    await flushPromises();
    second.reject(new Error('Old failure.'));
    await flushPromises();
    expect(wrapper.find('p.notice.error').exists()).toBe(false);
    expect(wrapper.get(t('preview')).attributes('src')).toBe(`/img/${ID_B}`);
  });

  it('ignores an answer that arrives after Cancel or after unmounting', async () => {
    const { wrapper, generate } = setup();
    const answer = deferred<PictureIdResponse>();
    generate.mockReturnValueOnce(answer.promise);
    await wrapper.get(t('create')).trigger('click');
    wrapper.unmount();
    answer.resolve({ imageId: ID_A });
    await flushPromises();
    expect(wrapper.emitted('use')).toBeUndefined();
  });

  it('disables Create portrait and says what to write when appearance and specialty are both blank', async () => {
    const { wrapper, generate } = setup({ details: { ...details, appearance: '  ', role: '' } });
    expect(wrapper.get(t('create')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(t('needs-look')).text()).toBe('Write the Appearance first.');
    await wrapper.get(t('create')).trigger('click');
    expect(generate).not.toHaveBeenCalled();
    await wrapper.setProps({ details: { ...details, appearance: '', role: 'Records' } });
    expect(wrapper.get(t('create')).attributes('disabled')).toBeUndefined();
    expect(wrapper.find(t('needs-look')).exists()).toBe(false);
  });

  it('disables every button while the form is disabled', async () => {
    const { wrapper } = setup({ portraitId: ID_A, disabled: true });
    expect(wrapper.get(t('create')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(t('remove')).attributes('disabled')).toBeDefined();
    await wrapper.get(t('remove')).trigger('click');
    expect(wrapper.emitted('remove')).toBeUndefined();
  });
});
