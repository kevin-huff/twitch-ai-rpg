// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { CommandSchema, NpcSchema } from '@rpg/contracts';
import type { DirectorSnapshot } from '@rpg/contracts';
import CastPresence from './CastPresence.vue';

const mara = NpcSchema.parse({ id: 'mara', displayName: 'Mara', role: 'Keeper', locationId: 'bar', status: 'present', voiceProfileId: 'voice_mara' });
function snapshot(patch: { status?: string; activeBeat?: unknown; setup?: unknown; npcs?: unknown[]; stateRevision?: number } = {}): DirectorSnapshot {
  const npcs = patch.npcs ?? [mara, { ...mara, id: 'dax', displayName: 'Dax', status: 'present', locationId: 'tower' }, { ...mara, id: 'ivy', displayName: 'Ivy', status: 'offstage', locationId: 'bar' }];
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'Test show', stateRevision: patch.stateRevision ?? 7, status: patch.status ?? 'live', mode: 'conversation', beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'The bar', description: 'A quiet place.', locationId: 'bar' } },
    locations: [{ id: 'bar', title: 'The bar', description: '' }, { id: 'tower', title: 'The tower', description: '' }],
    characters: [], npcs, npcDetails: npcs, characterDetails: [], tracks: [], facts: [], history: [], corrections: [],
    activeBeat: patch.activeBeat ?? null, submissions: [], jobs: [], setup: patch.setup,
  } as unknown as DirectorSnapshot;
}
const beat = (phase: string) => ({ id: 'beat1', phase });
const field = (id: string) => `[data-testid="${id}"]`;
const mountPanel = (current = snapshot(), busy = false) => mount(CastPresence, { props: { snapshot: current, busy } });

describe('Who is here panel', () => {
  it('lists who is here now, or says nobody is', async () => {
    expect(mountPanel().get(field('cast-here-now')).text()).toBe('Here now: Mara');
    const empty = snapshot({ npcs: [{ ...mara, status: 'offstage' }] });
    expect(mountPanel(empty).get(field('cast-here-now')).text()).toBe('Nobody else is here.');
  });

  it('opens a checklist ticked for the characters here, not ones present elsewhere', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    expect((wrapper.get(field('here-mara')).element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get(field('here-dax')).element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.get(field('here-ivy')).element as HTMLInputElement).checked).toBe(false);
  });

  it('emits a valid set_cast with the ticked ids and the captured revision, and closes when saved', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    await wrapper.get(field('here-ivy')).setValue(true);
    await wrapper.get('form').trigger('submit');
    const [command, onSaved] = wrapper.emitted('command')![0] as [unknown, () => void];
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(command).toMatchObject({ type: 'set_cast', expectedStateRevision: 7 });
    expect([...(command as { presentNpcIds: string[] }).presentNpcIds].sort()).toEqual(['ivy', 'mara']);
    onSaved();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('Saved who is here.');
  });

  it('disables Save when nothing changed or while busy, and sends nothing', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('here-ivy')).setValue(true);
    expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ busy: true });
    expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(field('begin-cast')).attributes('disabled')).toBeDefined();
  });

  it('Cancel closes the form without sending', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    await wrapper.get(field('cancel-cast')).trigger('click');
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined();
  });

  describe('gates', () => {
    it('allows no round, a collecting round and stakes review', () => {
      for (const current of [snapshot(), snapshot({ activeBeat: beat('collecting') }), snapshot({ activeBeat: beat('stakes_review') }), snapshot({ status: 'paused' })]) {
        const wrapper = mountPanel(current);
        expect(wrapper.find('.notice:not([data-testid="cast-round-open"])').exists()).toBe(false);
        expect(wrapper.get(field('begin-cast')).attributes('disabled')).toBeUndefined();
      }
    });
    it.each(['locked', 'draft_review'])('blocks a round in %s', phase => {
      const wrapper = mountPanel(snapshot({ activeBeat: beat(phase) }));
      expect(wrapper.text()).toContain('Publish or abandon this round first.');
      expect(wrapper.get(field('begin-cast')).attributes('disabled')).toBeDefined();
    });
    it('blocks a show that has not started, has ended, or is in the lobby', () => {
      const cases: [DirectorSnapshot, string][] = [
        [snapshot({ setup: { started: false } }), 'Start the show from Cast & lobby first.'],
        [snapshot({ status: 'ended' }), 'The show has ended.'],
        [snapshot({ status: 'lobby' }), 'Open a conversation or an action round first.'],
      ];
      for (const [current, text] of cases) {
        const wrapper = mountPanel(current);
        expect(wrapper.text()).toContain(text);
        expect(wrapper.get(field('begin-cast')).attributes('disabled')).toBeDefined();
      }
    });
    it('disables Save when a round moves past collecting while the form is open', async () => {
      const wrapper = mountPanel();
      await wrapper.get(field('begin-cast')).trigger('click');
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.setProps({ snapshot: snapshot({ activeBeat: beat('locked') }) });
      expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeDefined();
    });
  });

  describe('when the show changes while the form is open', () => {
    it('reloads quietly when no tick was changed', async () => {
      const wrapper = mountPanel();
      await wrapper.get(field('begin-cast')).trigger('click');
      const moved = [{ ...mara, status: 'offstage' }, { ...mara, id: 'dax', displayName: 'Dax', status: 'present', locationId: 'bar' }, { ...mara, id: 'ivy', displayName: 'Ivy', status: 'offstage', locationId: 'bar' }];
      await wrapper.setProps({ snapshot: snapshot({ stateRevision: 8, npcs: moved }) });
      expect(wrapper.find(field('cast-reset')).exists()).toBe(false);
      expect((wrapper.get(field('here-dax')).element as HTMLInputElement).checked).toBe(true);
      expect((wrapper.get(field('here-mara')).element as HTMLInputElement).checked).toBe(false);
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.get('form').trigger('submit');
      expect(wrapper.emitted('command')![0][0]).toMatchObject({ expectedStateRevision: 8 });
    });

    it('shows a notice and Start over when a tick was changed, and Save waits', async () => {
      const wrapper = mountPanel();
      await wrapper.get(field('begin-cast')).trigger('click');
      await wrapper.get(field('here-ivy')).setValue(true);
      const moved = [mara, { ...mara, id: 'dax', displayName: 'Dax', status: 'present', locationId: 'bar' }, { ...mara, id: 'ivy', displayName: 'Ivy', status: 'offstage', locationId: 'bar' }];
      await wrapper.setProps({ snapshot: snapshot({ stateRevision: 8, npcs: moved }) });
      expect(wrapper.text()).toContain('The show changed while you were choosing. Press Start over to see who is here now.');
      expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeDefined();
      expect((wrapper.get(field('here-ivy')).element as HTMLInputElement).checked).toBe(true);
      await wrapper.get(field('cast-reset')).trigger('click');
      expect(wrapper.find(field('cast-reset')).exists()).toBe(false);
      expect((wrapper.get(field('here-ivy')).element as HTMLInputElement).checked).toBe(false);
      expect((wrapper.get(field('here-dax')).element as HTMLInputElement).checked).toBe(true);
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.get('form').trigger('submit');
      expect(wrapper.emitted('command')![0][0]).toMatchObject({ expectedStateRevision: 8 });
    });

    it('keeps the notice and Start over when the ticks are set back to how they started', async () => {
      const wrapper = mountPanel();
      await wrapper.get(field('begin-cast')).trigger('click');
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.setProps({ snapshot: snapshot({ stateRevision: 8 }) });
      await wrapper.get(field('here-ivy')).setValue(false);
      expect(wrapper.text()).toContain('The show changed while you were choosing.');
      expect(wrapper.find(field('cast-reset')).exists()).toBe(true);
      expect(wrapper.get(field('save-cast')).attributes('disabled')).toBeDefined();
    });
  });

  it('reads Saving only during its own save, never Waiting for the AI', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    await wrapper.get(field('here-ivy')).setValue(true);
    expect(wrapper.get(field('save-cast')).text()).toBe('Save who is here');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get(field('save-cast')).text()).toBe('Saving…');
    expect(wrapper.text()).not.toContain('Waiting for the AI to finish');
  });

  describe('a round that is open', () => {
    const r1 = 'A round is open. Saving this sends it back to taking lines and throws away its plan, even one the AI is still making. Press Plan to plan it again. That is another AI call.';
    it('shows the note only while collecting or reviewing stakes', () => {
      for (const phase of ['collecting', 'stakes_review']) expect(mountPanel(snapshot({ activeBeat: beat(phase) })).get(field('cast-round-open')).text()).toBe(r1);
      for (const current of [snapshot(), snapshot({ activeBeat: beat('locked') }), snapshot({ activeBeat: beat('draft_review') })]) expect(mountPanel(current).find(field('cast-round-open')).exists()).toBe(false);
    });
    it.each(['collecting', 'stakes_review'])('adds the plan-again sentence to the saved notice in %s', async phase => {
      const wrapper = mountPanel(snapshot({ activeBeat: beat(phase) }));
      await wrapper.get(field('begin-cast')).trigger('click');
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.get('form').trigger('submit');
      (wrapper.emitted('command')![0] as [unknown, () => void])[1]();
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toContain('Saved who is here. The round went back to taking lines. Press Plan to plan it again.');
    });
    it('keeps the short saved notice when no round was open', async () => {
      const wrapper = mountPanel();
      await wrapper.get(field('begin-cast')).trigger('click');
      await wrapper.get(field('here-ivy')).setValue(true);
      await wrapper.get('form').trigger('submit');
      (wrapper.emitted('command')![0] as [unknown, () => void])[1]();
      await wrapper.vm.$nextTick();
      expect(wrapper.get('[role="status"]').text()).toBe('Saved who is here.');
    });
  });

  it('gives every checkbox its own help line over 20 characters, outside its label', async () => {
    const wrapper = mountPanel();
    await wrapper.get(field('begin-cast')).trigger('click');
    const ids = new Set<string>();
    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      const id = box.attributes('aria-describedby')!;
      expect(id).toBeTruthy();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      const help = wrapper.findAll('p.field-help').find(item => item.attributes('id') === id)!;
      expect(help.text().length).toBeGreaterThan(20);
      expect(box.element.closest('label')!.contains(help.element)).toBe(false);
    }
    expect(wrapper.findAll('p.field-help').map(item => item.text())).toContain('Ticked means Mara is here and players can talk to them. Unticked sends Mara offstage.');
  });
});
