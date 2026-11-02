// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShelfPicture } from '@rpg/contracts';
import PictureShelf from './PictureShelf.vue';

const transport = vi.hoisted(() => ({ pictures: vi.fn(), pinPicture: vi.fn(), drawBeatPicture: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const uuid = (n: number) => `6f1c2b7e-9a3d-4e5f-8b21-0c4d5e6f70${String(n).padStart(2, '0')}`;
const row = (n: number, over: Partial<ShelfPicture> = {}): ShelfPicture => ({
  imageId: uuid(n), kind: 'beat', label: `Beat ${n}`, scene: 'The Velvet Static', status: 'ready', message: null,
  onStream: false, pinned: false, held: false, shelfOnly: false, beatId: `beat-${n}`, createdAt: `2026-11-02T10:0${n}:00.000Z`, ...over,
});
const snapshot = (eventSeq: number) => ({ eventSeq, session: { id: 'show-1' } }) as never;

const mountShelf = (eventSeq = 1, busy = false) => mount(PictureShelf, { props: { sessionId: 'show-1', snapshot: snapshot(eventSeq), busy } });
async function openShelf(wrapper: VueWrapper) {
  const details = wrapper.get('[data-testid="picture-shelf"]').element as HTMLDetailsElement;
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  await flushPromises();
}
async function closeShelf(wrapper: VueWrapper) {
  const details = wrapper.get('[data-testid="picture-shelf"]').element as HTMLDetailsElement;
  details.open = false;
  details.dispatchEvent(new Event('toggle'));
  await flushPromises();
}
const item = (wrapper: VueWrapper, n: number) => wrapper.find(`[data-testid="shelf-picture-${uuid(n)}"]`);

beforeEach(() => { vi.clearAllMocks(); transport.pictures.mockResolvedValue({ pictures: [] }); transport.pinPicture.mockResolvedValue({ ok: true }); transport.drawBeatPicture.mockResolvedValue({ imageId: 'x' }); });

describe('picture shelf', () => {
  it('starts closed with its summary and loads nothing until opened', async () => {
    const wrapper = mountShelf();
    await flushPromises();
    expect(wrapper.get('summary').text()).toBe('Picture shelf');
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['panel', 'picture-shelf']));
    expect((wrapper.element as HTMLDetailsElement).open).toBe(false);
    expect(transport.pictures).not.toHaveBeenCalled();
    await openShelf(wrapper);
    expect(transport.pictures).toHaveBeenCalledTimes(1);
    expect(transport.pictures).toHaveBeenCalledWith('show-1');
  });

  it('says there are no pictures when the list is empty', async () => {
    const wrapper = mountShelf();
    await openShelf(wrapper);
    expect(wrapper.get('[data-testid="shelf-empty"]').text()).toBe('No pictures yet.');
    expect(wrapper.find('[data-testid="shelf-group-scenes"]').exists()).toBe(false);
  });

  it('keeps portraits apart and each group in the order the server sent', async () => {
    transport.pictures.mockResolvedValue({ pictures: [
      row(5, { kind: 'place', label: 'The cellar', beatId: null }),
      row(4, { kind: 'portrait', label: 'Portrait of Skooty', scene: null, beatId: null }),
      row(3),
      row(2, { kind: 'portrait', label: 'Portrait of Mara', scene: null, beatId: null }),
      row(1),
    ] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    const scenes = wrapper.get('[data-testid="shelf-group-scenes"]');
    const portraits = wrapper.get('[data-testid="shelf-group-portraits"]');
    expect(scenes.get('h3').text()).toBe('Scene pictures');
    expect(portraits.get('h3').text()).toBe('Portraits');
    expect(scenes.findAll('.shelf-label').map(node => node.text())).toEqual(['The cellar', 'Beat 3', 'Beat 1']);
    expect(portraits.findAll('.shelf-label').map(node => node.text())).toEqual(['Portrait of Skooty', 'Portrait of Mara']);
    expect(item(wrapper, 3).text()).toContain('The Velvet Static');
  });

  it('shows lazy thumbnails only for ready pictures', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(3), row(2, { status: 'making' }), row(1, { status: 'failed', message: 'The picture service is busy.' })] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    const thumb = item(wrapper, 3).get('img');
    expect(thumb.attributes('loading')).toBe('lazy');
    expect(thumb.attributes('src')).toContain(`/api/sessions/show-1/images/${uuid(3)}`);
    expect(thumb.attributes('alt')).toBe('Beat 3');
    expect(item(wrapper, 2).find('img').exists()).toBe(false);
    expect(item(wrapper, 1).find('img').exists()).toBe(false);
  });

  it('falls back to an empty frame when a file does not load', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(3)] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    await item(wrapper, 3).get('img').trigger('error');
    expect(item(wrapper, 3).find('img').exists()).toBe(false);
    expect(item(wrapper, 3).text()).toContain('Beat 3');
  });

  it('says what each picture is doing and tags the stream and pinned pictures', async () => {
    transport.pictures.mockResolvedValue({ pictures: [
      row(4, { status: 'making', held: true }),
      row(3, { held: true }),
      row(2, { status: 'failed', message: 'The picture service is busy.' }),
      row(1, { onStream: true, pinned: true }),
    ] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    expect(item(wrapper, 4).get('[data-testid^="shelf-status-"]').text()).toBe('Being drawn…');
    expect(item(wrapper, 3).get('[data-testid^="shelf-status-"]').text()).toBe('Shown when you publish the beat.');
    expect(item(wrapper, 2).get('[data-testid^="shelf-status-"]').text()).toBe('Could not be drawn.');
    expect(item(wrapper, 2).text()).toContain('The picture service is busy.');
    expect(item(wrapper, 1).find('[data-testid^="shelf-status-"]').exists()).toBe(false);
    expect(item(wrapper, 1).get('[data-testid="shelf-tag-stream"]').text()).toBe('On stream');
    expect(item(wrapper, 1).get('[data-testid="shelf-tag-pinned"]').text()).toBe('Pinned');
    expect(item(wrapper, 3).find('[data-testid="shelf-tag-stream"]').exists()).toBe(false);
    expect(item(wrapper, 3).find('[data-testid="shelf-tag-pinned"]').exists()).toBe(false);
  });

  it('reloads when a new event arrives while open, and not while closed', async () => {
    const wrapper = mountShelf(1);
    await wrapper.setProps({ snapshot: snapshot(2) });
    await flushPromises();
    expect(transport.pictures).not.toHaveBeenCalled();
    await openShelf(wrapper);
    expect(transport.pictures).toHaveBeenCalledTimes(1);
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    await wrapper.setProps({ snapshot: snapshot(3) });
    await flushPromises();
    expect(transport.pictures).toHaveBeenCalledTimes(2);
    expect(item(wrapper, 1).exists()).toBe(true);
    await closeShelf(wrapper);
    await wrapper.setProps({ snapshot: snapshot(4) });
    await flushPromises();
    expect(transport.pictures).toHaveBeenCalledTimes(2);
  });

  it('keeps one request in flight and loads once more after it when events pile up', async () => {
    let release: (value: { pictures: ShelfPicture[] }) => void = () => {};
    transport.pictures.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const wrapper = mountShelf(1);
    await openShelf(wrapper);
    expect(transport.pictures).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ snapshot: snapshot(2) });
    await wrapper.setProps({ snapshot: snapshot(3) });
    await flushPromises();
    expect(transport.pictures).toHaveBeenCalledTimes(1);
    transport.pictures.mockResolvedValue({ pictures: [row(2)] });
    release({ pictures: [row(1)] });
    await flushPromises();
    expect(transport.pictures).toHaveBeenCalledTimes(2);
    expect(item(wrapper, 2).exists()).toBe(true);
    expect(item(wrapper, 1).exists()).toBe(false);
  });

  it('shows a failed load as an alert and recovers on the next event', async () => {
    transport.pictures.mockRejectedValueOnce(new Error('Only the director can see the picture list.'));
    const wrapper = mountShelf(1);
    await openShelf(wrapper);
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe('Only the director can see the picture list.');
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    await wrapper.setProps({ snapshot: snapshot(2) });
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(item(wrapper, 1).exists()).toBe(true);
  });

  it('keeps the old list on screen when a reload fails', async () => {
    transport.pictures.mockResolvedValueOnce({ pictures: [row(1)] });
    const wrapper = mountShelf(1);
    await openShelf(wrapper);
    transport.pictures.mockRejectedValueOnce(new Error('Request failed (500).'));
    await wrapper.setProps({ snapshot: snapshot(2) });
    await flushPromises();
    expect(item(wrapper, 1).exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('Request failed (500).');
  });

  const pinId = (n: number) => `[data-testid="shelf-pin-${uuid(n)}"]`;
  const redrawId = (n: number) => `[data-testid="shelf-redraw-${uuid(n)}"]`;

  it('offers Show on stream to ready, unheld, unpinned pictures and Draw again to pictures with a beat', async () => {
    transport.pictures.mockResolvedValue({ pictures: [
      row(1), row(2, { pinned: true }), row(3, { held: true }), row(4, { status: 'making' }), row(5, { kind: 'portrait', beatId: null }), row(6, { beatId: null, kind: 'place' }),
    ] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    expect(wrapper.find(pinId(1)).text()).toBe('Show on stream');
    expect(wrapper.find(redrawId(1)).text()).toBe('Draw again');
    expect(wrapper.find(pinId(2)).exists()).toBe(false);
    expect(wrapper.find(redrawId(2)).exists()).toBe(true);
    expect(wrapper.find(pinId(3)).exists()).toBe(false);
    expect(wrapper.find(pinId(4)).exists()).toBe(false);
    expect(wrapper.find(pinId(5)).exists()).toBe(true);
    expect(wrapper.find(redrawId(5)).exists()).toBe(false);
    expect(wrapper.find(redrawId(6)).exists()).toBe(false);
  });

  it('pins a picture, then reloads the list', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    await wrapper.get(pinId(1)).trigger('click');
    await flushPromises();
    expect(transport.pinPicture).toHaveBeenCalledWith('show-1', uuid(1));
    expect(transport.pictures).toHaveBeenCalledTimes(2);
  });

  it('draws again for the picture beat, says so, and reloads', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    const wrapper = mountShelf();
    await openShelf(wrapper);
    await wrapper.get(redrawId(1)).trigger('click');
    await flushPromises();
    expect(transport.drawBeatPicture).toHaveBeenCalledWith('show-1', 'beat-1');
    expect(wrapper.get('[data-testid="shelf-notice"]').text()).toBe('Drawing again. The new picture goes on the shelf.');
    expect(transport.pictures).toHaveBeenCalledTimes(2);
  });

  it('shows a refused request inline and does not reload', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    transport.pinPicture.mockRejectedValue(new Error('Only a finished picture from this show can go on the stream.'));
    const wrapper = mountShelf();
    await openShelf(wrapper);
    await wrapper.get(pinId(1)).trigger('click');
    await flushPromises();
    const alert = wrapper.get('[data-testid="shelf-action-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe('Only a finished picture from this show can go on the stream.');
    expect(transport.pictures).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="shelf-notice"]').exists()).toBe(false);
  });

  it('disables the buttons while busy, during a request, and after the show ended', async () => {
    transport.pictures.mockResolvedValue({ pictures: [row(1)] });
    const busy = mountShelf(1, true);
    await openShelf(busy);
    expect(busy.get(pinId(1)).attributes('disabled')).toBeDefined();
    expect(busy.get(redrawId(1)).attributes('disabled')).toBeDefined();

    let finish!: () => void;
    transport.pinPicture.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const wrapper = mountShelf();
    await openShelf(wrapper);
    await wrapper.get(pinId(1)).trigger('click');
    expect(wrapper.get(pinId(1)).attributes('disabled')).toBeDefined();
    expect(wrapper.get(redrawId(1)).attributes('disabled')).toBeDefined();
    finish();
    await flushPromises();
    expect(wrapper.get(pinId(1)).attributes('disabled')).toBeUndefined();

    const ended = mount(PictureShelf, { props: { sessionId: 'show-1', snapshot: { eventSeq: 1, session: { id: 'show-1', status: 'ended' } } as never, busy: false } });
    await openShelf(ended);
    expect(ended.get(pinId(1)).attributes('disabled')).toBeDefined();
  });
});
