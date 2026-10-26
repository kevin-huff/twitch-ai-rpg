// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NpcPortraitControls from './NpcPortraitControls.vue';
import PictureAvatar from './PictureAvatar.vue';

const base = { name: 'Mara Vale', imageUrl: null, enabled: true, canCreate: true };
const create = (w: ReturnType<typeof mount>) => w.find('[data-testid="npc-portrait-create"]');
const remove = (w: ReturnType<typeof mount>) => w.find('[data-testid="npc-portrait-remove"]');

describe('NpcPortraitControls', () => {
  it('renders nothing when pictures are off', () => {
    const w = mount(NpcPortraitControls, { props: { ...base, enabled: false } });
    expect(w.html()).toBe('<!--v-if-->');
  });

  it('shows initials and Create portrait with no image', () => {
    const w = mount(NpcPortraitControls, { props: base });
    expect(w.find('.avatar').text()).toBe('MV');
    expect(create(w).text()).toBe('Create portrait');
    expect(create(w).attributes('disabled')).toBeUndefined();
    expect(remove(w).exists()).toBe(false);
    expect(w.text()).not.toContain('Making');
  });

  it('shows Remove portrait with an image and emits create and remove', async () => {
    const w = mount(NpcPortraitControls, { props: { ...base, imageUrl: '/p.png' } });
    expect(w.find('img').attributes('alt')).toBe('Portrait of Mara Vale');
    expect(remove(w).text()).toBe('Remove portrait');
    await create(w).trigger('click');
    await remove(w).trigger('click');
    expect(w.emitted('create')).toHaveLength(1);
    expect(w.emitted('remove')).toHaveLength(1);
  });

  it('shows the making line, disables Create and hides Remove while making', () => {
    const w = mount(NpcPortraitControls, { props: { ...base, imageUrl: '/p.png', state: 'making' } });
    expect(w.text()).toContain('Making the portrait...');
    expect(create(w).attributes('disabled')).toBeDefined();
    expect(remove(w).exists()).toBe(false);
  });

  it('shows the failure message or the default sentence', () => {
    const own = mount(NpcPortraitControls, { props: { ...base, state: 'failed', message: 'Out of credit.' } });
    expect(own.text()).toContain('Out of credit.');
    const plain = mount(NpcPortraitControls, { props: { ...base, state: 'failed' } });
    expect(plain.text()).toContain('The portrait could not be made. Press Create portrait to try again.');
    expect(create(plain).attributes('disabled')).toBeUndefined();
  });

  it('explains and disables Create when there is nothing to draw', async () => {
    const w = mount(NpcPortraitControls, { props: { ...base, canCreate: false } });
    expect(w.text()).toContain('Give this character an appearance or a role first.');
    expect(create(w).attributes('disabled')).toBeDefined();
    await create(w).trigger('click');
    expect(w.emitted('create')).toBeUndefined();
  });

  it('disables both buttons when disabled', () => {
    const w = mount(NpcPortraitControls, { props: { ...base, imageUrl: '/p.png', disabled: true } });
    expect(create(w).attributes('disabled')).toBeDefined();
    expect(remove(w).attributes('disabled')).toBeDefined();
  });
});

describe('PictureAvatar', () => {
  it('sizes the root and shows the image', () => {
    const w = mount(PictureAvatar, { props: { name: 'Mara Vale', src: '/a.png', size: 64 } });
    expect(w.element.tagName).toBe('SPAN');
    expect(w.classes()).toContain('avatar');
    expect((w.element as HTMLElement).style.width).toBe('64px');
    expect((w.element as HTMLElement).style.height).toBe('64px');
    expect(w.find('img').attributes('src')).toBe('/a.png');
  });

  it('falls back to initials on error and recovers when src changes', async () => {
    const w = mount(PictureAvatar, { props: { name: 'Mara Vale', src: '/a.png' } });
    await w.find('img').trigger('error');
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toBe('MV');
    await w.setProps({ src: '/b.png' });
    expect(w.find('img').attributes('src')).toBe('/b.png');
  });

  it('shows initials without a src', () => {
    const w = mount(PictureAvatar, { props: { name: 'Mara Vale' } });
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).toBe('MV');
  });
});
