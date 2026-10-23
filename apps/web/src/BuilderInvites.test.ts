// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BuilderInvites from './BuilderInvites.vue';

const transport = vi.hoisted(() => ({ characterBuilders: vi.fn(), createCharacterBuilder: vi.fn(), characterBuilderLink: vi.fn(), revokeCharacterBuilder: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));
const builder = { id: 'builder-one', label: 'Alex', instructions: 'Build an explorer.', createdAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-11-21T12:00:00.000Z', revokedAt: null, submittedAt: null, submittedTemplate: null };
async function open(wrapper: ReturnType<typeof mount>) {
  (wrapper.get('details').element as HTMLDetailsElement).open = true;
  await wrapper.get('details').trigger('toggle'); await flushPromises();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-22T12:00:00.000Z').getTime());
  window.history.replaceState({}, '', `/library?identity=${'a'.repeat(32)}`);
  transport.characterBuilders.mockResolvedValue({ builders: [structuredClone(builder)] });
  transport.createCharacterBuilder.mockResolvedValue({ builder, token: 'private/token' });
  transport.characterBuilderLink.mockResolvedValue({ builder, token: 'existing/token' });
  transport.revokeCharacterBuilder.mockResolvedValue({ ...builder, revokedAt: '2026-10-23T12:00:00.000Z' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('private character invitations', () => {
  it('makes no requests before the collapsed panel is explicitly opened', async () => {
    const wrapper = mount(BuilderInvites); await flushPromises();
    expect(wrapper.get('summary').text()).toBe('Invite players to build characters');
    expect(wrapper.find('[data-testid="create-builder-link"]').exists()).toBe(false);
    expect(transport.characterBuilders).not.toHaveBeenCalled();
    await open(wrapper);
    expect(transport.characterBuilders).toHaveBeenCalledOnce();
    expect(wrapper.emitted('refresh-library')).toBeUndefined();
    expect(wrapper.text()).toContain('Alex'); wrapper.unmount();
  });

  it('creates a private reusable link without a host identity and explains public instructions', async () => {
    const wrapper = mount(BuilderInvites); await open(wrapper);
    await wrapper.get('[data-testid="builder-label"]').setValue('Alex');
    await wrapper.get('[data-testid="builder-instructions"]').setValue('Build an explorer.');
    await wrapper.get('[data-testid="create-builder-link"]').trigger('click'); await flushPromises();
    expect(transport.createCharacterBuilder).toHaveBeenCalledWith({ commandId: expect.any(String), label: 'Alex', instructions: 'Build an explorer.' });
    const link = wrapper.get('[data-testid="builder-link"]');
    expect((link.element as HTMLInputElement).value).toBe(`${window.location.origin}/build-character#token=private%2Ftoken`);
    expect(link.attributes('readonly')).toBeDefined();
    expect(wrapper.text()).toContain('private scenario');
    for (const input of wrapper.findAll('input, textarea')) {
      const id = input.attributes('aria-describedby');
      expect(id).toBeTruthy(); expect(wrapper.find(`[id="${id}"]`).exists()).toBe(true);
      expect(input.element.closest('label')).not.toBeNull();
    }
    expect(wrapper.emitted('refresh-library')).toBeUndefined(); wrapper.unmount();
  });

  it('preserves the previous link and entered instructions after a failed create and retries safely', async () => {
    const wrapper = mount(BuilderInvites); await open(wrapper);
    await wrapper.get('[data-testid="builder-label"]').setValue('Alex');
    await wrapper.get('[data-testid="create-builder-link"]').trigger('click'); await flushPromises();
    transport.createCharacterBuilder.mockRejectedValueOnce(new Error('Connection lost'));
    await wrapper.get('[data-testid="builder-label"]').setValue('Blair');
    await wrapper.get('[data-testid="builder-instructions"]').setValue('Keep my instructions');
    await wrapper.get('[data-testid="create-builder-link"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Connection lost');
    expect((wrapper.get('[data-testid="builder-link"]').element as HTMLInputElement).value).toContain('private%2Ftoken');
    expect((wrapper.get('[data-testid="builder-instructions"]').element as HTMLTextAreaElement).value).toBe('Keep my instructions');
    await wrapper.get('[aria-label="Dismiss error"]').trigger('click');
    await wrapper.get('[data-testid="create-builder-link"]').trigger('click'); await flushPromises();
    expect(transport.createCharacterBuilder.mock.calls[2]).toEqual(transport.createCharacterBuilder.mock.calls[1]);
    wrapper.unmount();
  });

  it('retrieves existing links and revokes them without changing other invitations', async () => {
    const wrapper = mount(BuilderInvites); await open(wrapper);
    await wrapper.get('[aria-label="Show link for Alex"]').trigger('click'); await flushPromises();
    expect(transport.characterBuilderLink).toHaveBeenCalledWith('builder-one');
    expect((wrapper.get('[data-testid="builder-link"]').element as HTMLInputElement).value).toContain('existing%2Ftoken');
    await wrapper.get('[aria-label="Revoke link for Alex"]').trigger('click'); await flushPromises();
    expect(transport.revokeCharacterBuilder).toHaveBeenCalledWith('builder-one', { commandId: expect.any(String) });
    expect(wrapper.text()).toContain('Revoked');
    expect(wrapper.find('[data-testid="builder-link"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Show link for Alex"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('refreshes the library only on explicit refresh and shows the submitted immutable version', async () => {
    const wrapper = mount(BuilderInvites); await open(wrapper);
    transport.characterBuilders.mockResolvedValue({ builders: [{ ...builder, submittedAt: '2026-10-23T12:00:00.000Z', submittedTemplate: { templateId: 'aster-card', version: 2 } }] });
    await wrapper.get('[data-testid="refresh-builder-submissions"]').trigger('click'); await flushPromises();
    expect(wrapper.emitted('refresh-library')).toHaveLength(1);
    expect(wrapper.text()).toContain('Submitted'); expect(wrapper.text()).not.toContain('aster-card'); expect(wrapper.text()).toContain('version 2');
    wrapper.unmount();
  });

  it('keeps existing invitations when refresh fails and respects parent busy state', async () => {
    const wrapper = mount(BuilderInvites); await open(wrapper);
    transport.characterBuilders.mockRejectedValueOnce(new Error('List unavailable'));
    await wrapper.get('[data-testid="refresh-builder-submissions"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('List unavailable');
    expect(wrapper.text()).toContain('Alex'); expect(wrapper.emitted('refresh-library')).toBeUndefined();
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get('[data-testid="create-builder-link"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="refresh-builder-submissions"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[aria-label="Revoke link for Alex"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});
