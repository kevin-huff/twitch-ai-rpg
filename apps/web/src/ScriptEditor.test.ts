// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import type { AiSegment, PublicNpc } from '@rpg/contracts';

vi.mock('./api', () => ({ api: { generateField: vi.fn() } }));

import ScriptEditor from './ScriptEditor.vue';
import FieldGenerator from './FieldGenerator.vue';

const npc = (id: string, displayName: string, status: 'present' | 'offstage' = 'present'): PublicNpc => ({ id, displayName, role: 'Guard', appearance: '', status, voiceProfileId: 'voice-' + id });
const narration = (text: string): AiSegment => ({ kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], text, delivery: 'neutral' });
const dialogue = (speakerNpcId: string, text: string): AiSegment => ({ kind: 'npc_dialogue', speakerNpcId, recipientCharacterIds: [], text, delivery: 'neutral' });
const npcs = [npc('ana', 'Ana'), npc('bo', 'Bo'), npc('gone', 'Gone', 'offstage')];
const id = (name: string) => `[data-testid="${name}"]`;

function mountEditor(list: AiSegment[], extra: Record<string, unknown> = {}) {
  const segments = reactive(list) as AiSegment[];
  const wrapper = mount(ScriptEditor, { props: { segments, npcs, busy: false, contextKey: 'ctx', ...extra } });
  return { wrapper, segments };
}

describe('script editor', () => {
  it('shows plain speaker and text rows with no editor open', () => {
    const { wrapper } = mountEditor([narration('Rain falls.'), dialogue('ana', 'Halt!'), narration('  ')]);
    expect(wrapper.get(id('script-line-0')).text()).toBe('Narrator: Rain falls.');
    expect(wrapper.get(id('script-line-1')).text()).toBe('Ana: Halt!');
    expect(wrapper.get(id('script-line-2')).text()).toBe('Narrator: (empty line)');
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.text()).toContain('Only saved edits are published.');
  });

  it('opens a row on click, keeps it open, and edits the text in place', async () => {
    const { wrapper, segments } = mountEditor([narration('Rain falls.'), narration('Wind.')]);
    await wrapper.get(id('script-line-0')).trigger('click');
    await wrapper.get(id('script-line-0')).trigger('click');
    expect(wrapper.findAll('textarea')).toHaveLength(1);
    expect(wrapper.findComponent(FieldGenerator).exists()).toBe(true);
    await wrapper.get(id('script-segment-0')).setValue('Snow falls.');
    expect(segments[0]!.text).toBe('Snow falls.');
    expect(wrapper.get(id('script-line-0')).text()).toBe('Narrator: Snow falls.');
    expect(wrapper.get(id('script-remove-0')).text()).toBe('Remove');
  });

  it('changes the speaker of an NPC line among present NPCs only', async () => {
    const { wrapper, segments } = mountEditor([dialogue('ana', 'Halt!')]);
    await wrapper.get(id('script-line-0')).trigger('click');
    const options = wrapper.get(id('script-speaker-0')).findAll('option').map(o => o.text());
    expect(options).toEqual(['Ana', 'Bo']);
    await wrapper.get(id('script-speaker-0')).setValue('bo');
    expect(segments[0]).toMatchObject({ kind: 'npc_dialogue', speakerNpcId: 'bo' });
    expect(wrapper.get(id('script-line-0')).text()).toBe('Bo: Halt!');
  });

  it('removes a line', async () => {
    const { wrapper, segments } = mountEditor([narration('One'), narration('Two')]);
    await wrapper.get(id('script-line-0')).trigger('click');
    await wrapper.get(id('script-remove-0')).trigger('click');
    expect(segments.map(s => s.text)).toEqual(['Two']);
    expect(wrapper.get(id('script-line-0')).text()).toBe('Narrator: Two');
  });

  it('adds a narrator line and an NPC line from the one select, opens each, and resets it', async () => {
    const { wrapper, segments } = mountEditor([narration('One')]);
    const select = wrapper.get(id('script-add-line'));
    expect(select.attributes('aria-label')).toBe('Add a line');
    expect(select.findAll('option').map(o => o.text())).toEqual(['Add a line…', 'Narrator', 'Ana', 'Bo']);
    await select.setValue('narration');
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ kind: 'narration', text: '' });
    expect(wrapper.find(id('script-segment-1')).exists()).toBe(true);
    expect((select.element as HTMLSelectElement).value).toBe('');
    await select.setValue('bo');
    expect(segments[2]).toMatchObject({ kind: 'npc_dialogue', speakerNpcId: 'bo', text: '' });
    expect(wrapper.find(id('script-segment-2')).exists()).toBe(true);
    expect(wrapper.get(id('script-line-2')).text()).toBe('Bo: (empty line)');
    expect((select.element as HTMLSelectElement).value).toBe('');
  });

  it('addNarration appends an empty narration line and opens it', async () => {
    const { wrapper, segments } = mountEditor([narration('One')]);
    (wrapper.vm as unknown as { addNarration: () => void }).addNarration();
    await nextTick();
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ kind: 'narration', text: '' });
    expect(wrapper.find(id('script-segment-1')).exists()).toBe(true);
    expect(wrapper.find(id('script-segment-0')).exists()).toBe(false);
  });

  it('keeps a row open and its generator context key after an earlier row is removed', async () => {
    const { wrapper, segments } = mountEditor([narration('One'), dialogue('ana', 'Two')]);
    await wrapper.get(id('script-line-0')).trigger('click');
    await wrapper.get(id('script-line-1')).trigger('click');
    const keys = () => wrapper.findAllComponents(FieldGenerator).map(g => String(g.props('contextKey')));
    const before = keys();
    expect(before).toHaveLength(2);
    expect(before[1]).toMatch(/^ctx:\d+:ana$/);
    await wrapper.get(id('script-remove-0')).trigger('click');
    expect(segments).toHaveLength(1);
    expect(wrapper.get(id('script-segment-0')).element).toBeTruthy();
    expect(keys()).toEqual([before[1]]);
  });

  it('passes the premise to the generator and disables buttons while busy', async () => {
    const { wrapper } = mountEditor([narration('One')], { premise: 'A siege.', premiseLabel: 'Show scenario: Siege', busy: true });
    await wrapper.get(id('script-line-0')).trigger('click');
    const generator = wrapper.getComponent(FieldGenerator);
    expect(generator.props()).toMatchObject({ premise: 'A siege.', premiseLabel: 'Show scenario: Siege', disabled: true, field: 'script.narration' });
    expect(wrapper.get(id('script-remove-0')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(id('script-add-line')).attributes('disabled')).toBeDefined();
    for (const button of wrapper.findAll('button')) expect(button.classes().some(c => c === 'quiet' || c === 'secondary' || c === 'script-line')).toBe(true);
  });

  it('renders a row as a script-line button with the speaker in bold that still opens the editor', async () => {
    const { wrapper } = mountEditor([dialogue('ana', 'Halt!')]);
    const row = wrapper.get(id('script-line-0'));
    expect(row.element.tagName).toBe('BUTTON');
    expect(row.classes()).toContain('script-line');
    expect(row.classes()).not.toContain('quiet');
    expect(row.get('strong').text()).toBe('Ana:');
    await row.trigger('click');
    expect(wrapper.find('textarea').exists()).toBe(true);
  });
});
