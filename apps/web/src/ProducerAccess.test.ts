// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'p1', label: 'Sam', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null, lastSignedInAt: null, activeSignIns: 0, ...over,
});
const token = 'tok_abcdefghijklmnopqrstuvwxyz';
const mocks = vi.hoisted(() => ({
  producers: vi.fn(), createProducer: vi.fn(), producerLink: vi.fn(), revokeProducer: vi.fn(), producerSignIn: vi.fn(), sessions: vi.fn(),
}));
vi.mock('./api', () => ({ api: mocks }));
import ProducerAccess from './ProducerAccess.vue';
import ProducerSignIn from './ProducerSignIn.vue';

enableAutoUnmount(afterEach);

const writeText = vi.fn();
beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  writeText.mockReset(); writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  mocks.producers.mockResolvedValue({ producers: [] });
});
const button = (w: ReturnType<typeof mount>, text: string) => w.findAll('button').find(b => b.text() === text)!;

describe('ProducerAccess', () => {
  it('creates a producer and shows the link with the token after the hash', async () => {
    mocks.createProducer.mockResolvedValue({ producer: summary(), token });
    const w = mount(ProducerAccess);
    await flushPromises();
    await w.find('input').setValue('Sam');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    expect(mocks.createProducer).toHaveBeenCalledWith('Sam');
    const url = (w.find('input[aria-label="Producer link for Sam"]').element as HTMLInputElement).value;
    expect(url.split('#')[0]).toMatch(/\/producer$/);
    expect(url.split('#')[1]).toBe(`token=${encodeURIComponent(token)}`);
    expect(w.find('form').exists()).toBe(false);
    expect(writeText).toHaveBeenCalledWith(url);
    expect(w.find('[data-testid="producer-copied"]').text()).toBe('Copied. Send it privately. It signs them in.');
  });

  it('selects the link box and says so when the clipboard fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    mocks.createProducer.mockResolvedValue({ producer: summary(), token });
    const w = mount(ProducerAccess, { attachTo: document.body });
    await flushPromises();
    await w.find('input').setValue('Sam');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="producer-copied"]').text()).toBe('Copy did not work. Select the link and copy it by hand.');
    const box = w.find('input[aria-label="Producer link for Sam"]').element as HTMLInputElement;
    expect(document.activeElement === box || box.selectionEnd! > box.selectionStart!).toBe(true);
  });

  it('shows an existing link again', async () => {
    mocks.producers.mockResolvedValue({ producers: [summary()] });
    mocks.producerLink.mockResolvedValue({ producer: summary(), token });
    const w = mount(ProducerAccess);
    await flushPromises();
    expect(w.text()).toContain('Active · not used yet');
    await button(w, 'Show link').trigger('click');
    await flushPromises();
    expect(mocks.producerLink).toHaveBeenCalledWith('p1');
    expect((w.find('input[aria-label="Producer link for Sam"]').element as HTMLInputElement).value).toContain('#token=');
  });

  it('requires confirmation before turning off', async () => {
    mocks.producers.mockResolvedValue({ producers: [summary()] });
    mocks.revokeProducer.mockResolvedValue(summary({ revokedAt: '2026-10-02T00:00:00.000Z' }));
    const w = mount(ProducerAccess);
    await flushPromises();
    await button(w, 'Turn off').trigger('click');
    expect(mocks.revokeProducer).not.toHaveBeenCalled();
    expect(w.text()).toContain("Turn off Sam's access? They are signed out of every tab right away.");
    await button(w, 'Keep access').trigger('click');
    expect(mocks.revokeProducer).not.toHaveBeenCalled();
    await button(w, 'Turn off').trigger('click');
    await button(w, 'Turn off').trigger('click');
    await flushPromises();
    expect(mocks.revokeProducer).toHaveBeenCalledWith('p1');
    expect(w.text()).toContain('Turned off');
  });

  it('ignores a reload that started before a revoke finished', async () => {
    mocks.producers.mockResolvedValueOnce({ producers: [summary()] });
    mocks.revokeProducer.mockResolvedValue(summary({ revokedAt: '2026-10-02T00:00:00.000Z' }));
    const w = mount(ProducerAccess);
    await flushPromises();
    let release!: (value: unknown) => void;
    mocks.producers.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mocks.producers.mockResolvedValueOnce({ producers: [summary({ revokedAt: '2026-10-02T00:00:00.000Z' })] });
    window.dispatchEvent(new Event('focus'));
    await button(w, 'Turn off').trigger('click');
    await button(w, 'Turn off').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Turned off');
    release({ producers: [summary()] });
    await flushPromises();
    expect(w.text()).toContain('Turned off');
    expect(w.text()).not.toContain('Active');
  });

  it('ignores a reload that started before a create finished', async () => {
    mocks.createProducer.mockResolvedValue({ producer: summary({ id: 'p2', label: 'Alex' }), token });
    const w = mount(ProducerAccess);
    await flushPromises();
    let release!: (value: unknown) => void;
    mocks.producers.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mocks.producers.mockResolvedValueOnce({ producers: [summary({ id: 'p2', label: 'Alex' })] });
    window.dispatchEvent(new Event('focus'));
    await w.find('input').setValue('Alex');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Alex');
    release({ producers: [] });
    await flushPromises();
    expect(w.text()).toContain('Alex');
  });

  it('shows older producers after a create made before the first load returned', async () => {
    let release!: (value: unknown) => void;
    mocks.producers.mockReset();
    mocks.producers.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mocks.producers.mockResolvedValueOnce({ producers: [summary(), summary({ id: 'p2', label: 'Alex' })] });
    mocks.createProducer.mockResolvedValue({ producer: summary({ id: 'p2', label: 'Alex' }), token });
    const w = mount(ProducerAccess);
    await w.find('input').setValue('Alex');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    release({ producers: [summary()] });
    await flushPromises();
    expect(mocks.producers).toHaveBeenCalledTimes(2);
    expect(w.text()).toContain('Sam');
    expect(w.text()).toContain('Alex');
  });

  it('shows older producers after a revoke made before the first load returned', async () => {
    const created = summary({ id: 'p2', label: 'Alex' });
    const revoked = summary({ id: 'p2', label: 'Alex', revokedAt: '2026-10-02T00:00:00.000Z' });
    let release!: (value: unknown) => void;
    mocks.producers.mockReset();
    mocks.producers.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    mocks.producers.mockResolvedValueOnce({ producers: [summary(), created] });
    mocks.producers.mockResolvedValueOnce({ producers: [summary(), revoked] });
    mocks.createProducer.mockResolvedValue({ producer: created, token });
    mocks.revokeProducer.mockResolvedValue(revoked);
    const w = mount(ProducerAccess);
    await w.find('input').setValue('Alex');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    const alex = () => w.findAll('li').find(li => li.text().includes('Alex'))!;
    await alex().findAll('button').find(b => b.text() === 'Turn off')!.trigger('click');
    await alex().findAll('button').find(b => b.text() === 'Turn off')!.trigger('click');
    await flushPromises();
    release({ producers: [summary()] });
    await flushPromises();
    expect(mocks.producers).toHaveBeenCalledTimes(3);
    expect(w.text()).toContain('Sam');
    expect(alex().text()).toContain('Turned off');
  });

  it('gives every input its own help text', async () => {
    mocks.createProducer.mockResolvedValue({ producer: summary(), token });
    const w = mount(ProducerAccess);
    await flushPromises();
    await button(w, 'Create producer link').trigger('click');
    await w.find('input').setValue('Sam');
    await button(w, 'Create producer link').trigger('click');
    await flushPromises();
    const ids = w.findAll('input').map(i => i.attributes('aria-describedby')!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      const help = w.find(`[id="${id}"]`);
      expect(help.classes()).toContain('field-help');
      expect(help.text().length).toBeGreaterThan(20);
    }
  });

  describe('background refresh', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('reloads every 30 seconds and shows the new status without blanking rows', async () => {
      mocks.producers.mockResolvedValueOnce({ producers: [summary()] });
      const w = mount(ProducerAccess);
      await flushPromises();
      expect(w.text()).toContain('Active · not used yet');
      mocks.producers.mockResolvedValueOnce({ producers: [summary({ activeSignIns: 1 })] });
      await vi.advanceTimersByTimeAsync(30000);
      await flushPromises();
      expect(mocks.producers).toHaveBeenCalledTimes(2);
      expect(w.text()).toContain('Signed in now');
      w.unmount();
    });

    it('reloads on window focus', async () => {
      const w = mount(ProducerAccess);
      await flushPromises();
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
      expect(mocks.producers).toHaveBeenCalledTimes(2);
      w.unmount();
    });

    it('stops reloading after unmount', async () => {
      const w = mount(ProducerAccess);
      await flushPromises();
      w.unmount();
      await vi.advanceTimersByTimeAsync(90000);
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
      expect(mocks.producers).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ProducerSignIn', () => {
  const replace = vi.fn();
  const original = window.location;
  beforeEach(() => {
    replace.mockReset();
    window.history.replaceState(null, '', `/producer#token=${token}`);
    Object.defineProperty(window, 'location', { value: { ...original, hash: `#token=${token}`, pathname: '/producer', search: '', replace }, configurable: true });
    mocks.producerSignIn.mockResolvedValue(undefined);
  });
  afterEach(() => { Object.defineProperty(window, 'location', { value: original, configurable: true }); });

  async function signIn() {
    const w = mount(ProducerSignIn);
    await w.find('button').trigger('click');
    await flushPromises();
  }

  it('lands on the director page when there is exactly one show', async () => {
    mocks.sessions.mockResolvedValue([{ id: 's1' }]);
    await signIn();
    expect(replace).toHaveBeenCalledWith('/sessions/s1/director');
  });

  it('goes home with two shows', async () => {
    mocks.sessions.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    await signIn();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('goes home when the list fails', async () => {
    mocks.sessions.mockRejectedValue(new Error('boom'));
    await signIn();
    expect(replace).toHaveBeenCalledWith('/');
  });
});
