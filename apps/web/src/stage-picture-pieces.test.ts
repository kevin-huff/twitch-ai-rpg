// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageParty from './StageParty.vue';
import StagePictureCorner from './StagePictureCorner.vue';
import partyFile from './StageParty.vue?raw';
import pictureFile from './StagePictureCorner.vue?raw';

const cssRule = (source: string, selector: string) => source.match(new RegExp('\\n' + selector.replace(/\./g, '\\.') + ' \\{([^}]*)\\}'))?.[1] ?? '';

function snapshot(overrides: Record<string, unknown> = {}): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Story Table', status: 'live', mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' }
    },
    characters: [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 8, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 1, appearance: '', approved: true, ready: true }
    ],
    npcs: [], tracks: [], facts: [], corrections: [], history: [], activeBeat: null,
    ...overrides
  } as unknown as SessionSnapshot;
}

const withPictures = (extra: Record<string, unknown> = {}) => {
  const base = snapshot();
  const characters = base.characters.map((character, index) => index === 0 ? { ...character, portraitId: 'p1' } : character);
  return snapshot({
    picturesEnabled: true, characters,
    scenePicture: { imageId: 'sp1', sceneId: 'sc', hidden: false, updatedAt: '2026-10-20T10:00:00.000Z' }, ...extra
  });
};
const party = (snap: SessionSnapshot, characterId?: string | null) => mount(StageParty, { props: { snapshot: snap, connected: true, characterId } });
const corner = (snap: SessionSnapshot) => mount(StagePictureCorner, { props: { snapshot: snap, connected: true } });

describe('StageParty', () => {
  it('draws a chip per character with Needs help at full strain', () => {
    const wrapper = party(snapshot());
    expect(wrapper.classes()).toContain('cast-chips');
    expect(wrapper.attributes('aria-label')).toBe('Cast');
    expect(wrapper.findAll('.chip')).toHaveLength(2);
    expect(wrapper.findAll('.chip-flag')).toHaveLength(1);
    expect(wrapper.get('.chip-flag').text()).toBe('Needs help');
    expect(wrapper.findAll('.chip')[0]!.findAll('.strain i')).toHaveLength(8);
    expect(wrapper.findAll('.chip')[0]!.findAll('.strain i.filled')).toHaveLength(8);
    expect(wrapper.findAll('.chip')[1]!.findAll('.strain i.filled')).toHaveLength(1);
  });

  it('keeps only the chosen character, and draws nothing for an unknown id', () => {
    const one = party(snapshot(), 'c2');
    expect(one.findAll('.chip')).toHaveLength(1);
    expect(one.text()).toContain('Tom Reed');
    expect(one.text()).not.toContain('Mara Vale');
    expect(party(snapshot(), 'nobody').html()).toBe('<!--v-if-->');
  });

  it('draws during a slate', () => {
    expect(party(snapshot({ session: { ...snapshot().session, status: 'ended' } })).findAll('.chip')).toHaveLength(2);
  });

  it('shows portraits and falls back to initials when one fails', async () => {
    const wrapper = party(withPictures());
    const chip = wrapper.get('img.chip-portrait');
    expect(chip.attributes('alt')).toBe('Portrait of Mara Vale');
    expect(chip.attributes('src')).toContain('/images/p1');
    expect(wrapper.findAll('.initials')).toHaveLength(1);
    await chip.trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.findAll('.initials')).toHaveLength(2);
  });

  it('tries a failed portrait again once the chip moves off it and back', async () => {
    const withPortrait = (portraitId: string) => {
      const base = withPictures();
      return { ...base, characters: base.characters.map((character, index) => index === 0 ? { ...character, portraitId } : character) };
    };
    const wrapper = party(withPortrait('p1'));
    await wrapper.get('img.chip-portrait').trigger('error');
    expect(wrapper.find('img.chip-portrait').exists()).toBe(false);
    await wrapper.setProps({ snapshot: withPortrait('p2') });
    expect(wrapper.get('img.chip-portrait').attributes('src')).toContain('/images/p2');
    await wrapper.setProps({ snapshot: withPortrait('p1') });
    expect(wrapper.get('img.chip-portrait').attributes('src')).toContain('/images/p1');
  });

  it('keeps its place on the 1920 by 1080 canvas', () => {
    const rule = cssRule(partyFile, '.cast-chips');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('left: 96px');
    expect(rule).toContain('top: 60px');
    expect(rule).toContain('width: 1344px');
    expect(rule).toContain('height: 76px');
  });
});

describe('StagePictureCorner', () => {
  it('shows the scene picture as the root image', () => {
    const wrapper = corner(withPictures());
    expect(wrapper.element.tagName).toBe('IMG');
    expect(wrapper.classes()).toContain('scene-corner');
    expect(wrapper.attributes('alt')).toBe('The Salt Bar');
    expect(wrapper.attributes('src')).toContain('/images/sp1');
  });

  it('shows a pinned picture over a newer scene picture, falls back when it breaks, and returns on Release', async () => {
    const pin = { imageId: 'pin1', kind: 'place', label: 'The old map' };
    const wrapper = corner(withPictures({ pinnedPicture: pin }));
    expect(wrapper.get('img.scene-corner').attributes('src')).toContain('/images/pin1');
    expect(wrapper.get('img.scene-corner').attributes('alt')).toBe('The old map');
    expect(wrapper.get('img.scene-corner').classes()).not.toContain('fit-whole');
    await wrapper.get('img.scene-corner').trigger('error');
    expect(wrapper.get('img.scene-corner').attributes('src')).toContain('/images/sp1');
    await wrapper.setProps({ snapshot: withPictures() });
    expect(wrapper.get('img.scene-corner').attributes('src')).toContain('/images/sp1');
    expect(wrapper.get('img.scene-corner').attributes('alt')).toBe('The Salt Bar');
  });

  it('shows a pinned portrait whole and shows nothing pinned with pictures off', () => {
    const pin = { imageId: 'pin2', kind: 'portrait', label: 'Portrait of Mara Vale' };
    expect(corner(withPictures({ pinnedPicture: pin })).get('img.scene-corner').classes()).toContain('fit-whole');
    expect(corner(withPictures({ pinnedPicture: pin, picturesEnabled: false })).find('img.scene-corner').exists()).toBe(false);
  });

  it('forgets a failed picture once it is hidden and tries it again when shown', async () => {
    const wrapper = corner(withPictures());
    await wrapper.get('img.scene-corner').trigger('error');
    expect(wrapper.find('img.scene-corner').exists()).toBe(false);
    await wrapper.setProps({ snapshot: withPictures({ summary: 'same picture still shown' }) });
    expect(wrapper.find('img.scene-corner').exists()).toBe(false);
    await wrapper.setProps({ snapshot: withPictures({ scenePicture: null }) });
    expect(wrapper.find('img.scene-corner').exists()).toBe(false);
    await wrapper.setProps({ snapshot: withPictures() });
    expect(wrapper.find('img.scene-corner').exists()).toBe(true);
  });

  it('shows nothing when pictures are off, hidden or from another scene', () => {
    expect(corner(withPictures({ picturesEnabled: false })).find('img').exists()).toBe(false);
    const stale = withPictures({ scenePicture: { imageId: 'sp1', sceneId: 'other', hidden: false, updatedAt: '2026-10-20T10:00:00.000Z' } });
    expect(corner(stale).find('.scene-corner').exists()).toBe(false);
  });

  it('draws during a slate', () => {
    expect(corner(withPictures({ session: { ...snapshot().session, status: 'ended' } })).find('img.scene-corner').exists()).toBe(true);
  });

  it('keeps its place on the 1920 by 1080 canvas', () => {
    const rule = cssRule(pictureFile, '.scene-corner');
    expect(rule).toContain('left: 96px');
    expect(rule).toContain('top: 184px');
    expect(rule).toContain('width: 336px');
    expect(rule).toContain('height: 192px');
  });
});
