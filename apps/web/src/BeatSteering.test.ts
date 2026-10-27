// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { BeatSchema, CommandSchema } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';
import BeatSteering from './BeatSteering.vue';

function snapshot(): DirectorSnapshot {
  return { schemaVersion: 1, role: 'director', eventSeq: 3, session: { id: 'show', title: 'Show', stateRevision: 7, status: 'live', mode: 'conversation', beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'The bar', description: '', locationId: 'bar' } }, locations: [], characters: [], characterDetails: [], npcs: [], npcDetails: [], tracks: [], facts: [], history: [], corrections: [], submissions: [], jobs: [], picturesEnabled: false, scenePicture: null, scenePictureStatus: null, actionPicture: null, pictureSettings: null, lastSceneBeatId: null, portraitJobs: [], gallery: null, directorNotes: '', activeBeat: BeatSchema.parse({ id: 'beat-one', sessionId: 'show', kind: 'conversation', phase: 'collecting', revision: 3, inputEpoch: 0, sourceStateRevision: 7, selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], stakesApproved: false, classification: null, inputSnapshotHash: null, resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 0, lastError: null, steering: 'Keep the mood hopeful.' }) };
}
const field = (name: string) => `[data-testid="${name}"]`;
function command(wrapper: ReturnType<typeof mount>, index = 0) { return wrapper.emitted('command')![index]![0] as Command; }

describe('private beat direction', () => {
  it('loads the saved note, explains who sees it and what saving changes, and saves only on explicit action', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    expect(wrapper.get('summary').text()).toBe('Note for the AI');
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('Keep the mood hopeful.');
    expect(wrapper.find('label').text()).toBe('Note for this beat');
    expect(wrapper.text()).toContain('Only you see this. The AI reads it the next time it plans or writes this beat; saving clears the current draft, and the dice stay the same.');
    expect(wrapper.get(field('save-beat-steering')).text()).toBe('Save note');
    expect(wrapper.get(field('clear-beat-steering')).text()).toBe('Clear note');
    await wrapper.get(field('beat-steering-text')).setValue('  Ask about the broken beacon.  ');
    expect(wrapper.text()).toContain('Unsaved note');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(command(wrapper)).toEqual({ type: 'set_beat_steering', commandId: expect.any(String), beatId: 'beat-one', expectedBeatRevision: 3, text: 'Ask about the broken beacon.' });
    expect(CommandSchema.safeParse(command(wrapper)).success).toBe(true); wrapper.unmount();
  });

  it('preserves failed save words and command identifier through unrelated snapshots', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('beat-steering-text')).setValue('Keep my unfinished direction');
    await wrapper.get(field('save-beat-steering')).trigger('click');
    const unrelated = snapshot(); unrelated.eventSeq++; unrelated.session.stateRevision++;
    await wrapper.setProps({ snapshot: unrelated, busy: true });
    expect(wrapper.get(field('beat-steering-text')).element.matches(':disabled')).toBe(true);
    await wrapper.setProps({ busy: false });
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('Keep my unfinished direction');
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(command(wrapper, 1)).toEqual(command(wrapper)); wrapper.unmount();
  });

  it('keeps stale edits until explicit reload and then uses the new beat revision', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('beat-steering-text')).setValue('My local direction');
    const next = snapshot(); next.activeBeat!.revision = 4; next.activeBeat!.steering = 'Another saved direction';
    await wrapper.setProps({ snapshot: next });
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('My local direction');
    expect(wrapper.get(field('save-beat-steering')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(field('clear-beat-steering')).attributes('disabled')).toBeDefined();
    await wrapper.get(field('reload-beat-steering')).trigger('click');
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('Another saved direction');
    await wrapper.get(field('beat-steering-text')).setValue('New local direction');
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(command(wrapper)).toMatchObject({ expectedBeatRevision: 4, text: 'New local direction' }); wrapper.unmount();
  });

  it('does not move unsaved direction into a different beat with the same revision', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('beat-steering-text')).setValue('For the first beat only');
    const next = snapshot(); next.activeBeat!.id = 'beat-two'; next.activeBeat!.steering = '';
    await wrapper.setProps({ snapshot: next });
    expect(wrapper.get(field('save-beat-steering')).attributes('disabled')).toBeDefined();
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('For the first beat only');
    await wrapper.get(field('reload-beat-steering')).trigger('click');
    await wrapper.get(field('beat-steering-text')).setValue('For the next beat');
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(command(wrapper)).toMatchObject({ beatId: 'beat-two', expectedBeatRevision: 3 }); wrapper.unmount();
  });

  it('clears saved direction with an explicit empty save and reports success after acknowledgement', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('clear-beat-steering')).trigger('click');
    expect(command(wrapper)).toMatchObject({ type: 'set_beat_steering', text: '', expectedBeatRevision: 3 });
    const saved = snapshot(); saved.activeBeat!.steering = ''; saved.activeBeat!.revision = 4;
    await wrapper.setProps({ snapshot: saved });
    (wrapper.emitted('command')![0]![1] as () => void)(); await wrapper.vm.$nextTick();
    expect(wrapper.get('[role="status"]').text()).toBe('Note cleared.');
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.find(field('reload-beat-steering')).exists()).toBe(false); wrapper.unmount();
  });

  it('validates direction length locally while keeping the overlong text for correction', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('beat-steering-text')).setValue('x'.repeat(3001));
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined(); expect(wrapper.get('[role="alert"]').text()).toContain('3000');
    expect((wrapper.get(field('beat-steering-text')).element as HTMLTextAreaElement).value).toHaveLength(3001);
    await wrapper.get(field('beat-steering-text')).setValue('x'.repeat(3000));
    await wrapper.get(field('save-beat-steering')).trigger('click');
    expect(command(wrapper)).toMatchObject({ text: 'x'.repeat(3000) }); wrapper.unmount();
  });

  it('acknowledges a save after the server refreshes an already clean draft', async () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    await wrapper.get(field('save-beat-steering')).trigger('click');
    const saved = snapshot(); saved.activeBeat!.revision = 4;
    await wrapper.setProps({ snapshot: saved });
    (wrapper.emitted('command')![0]![1] as () => void)(); await wrapper.vm.$nextTick();
    expect(wrapper.get('[role="status"]').text()).toBe('Note saved for the next plan or script.'); wrapper.unmount();
  });

  it('shows the note gates in plain words', () => {
    const noSetup = snapshot(); noSetup.setup = { started: false } as DirectorSnapshot['setup'];
    const wrapper = mount(BeatSteering, { props: { snapshot: noSetup, busy: false } });
    expect(wrapper.text()).toContain('Start the show before saving a note for the AI.');
    wrapper.unmount();
    const ended = snapshot(); ended.session.status = 'ended';
    const endedWrapper = mount(BeatSteering, { props: { snapshot: ended, busy: false } });
    expect(endedWrapper.text()).toContain('Notes for the AI work while the show is live or paused.');
    endedWrapper.unmount();
    const noBeat = snapshot(); noBeat.activeBeat = null;
    const noBeatWrapper = mount(BeatSteering, { props: { snapshot: noBeat, busy: false } });
    expect(noBeatWrapper.text()).toContain('Open a beat to save a note for the AI.');
    noBeatWrapper.unmount();
  });

  it('uses no session or private direction wording in the panel', () => {
    const wrapper = mount(BeatSteering, { props: { snapshot: snapshot(), busy: false } });
    expect(wrapper.text()).not.toMatch(/session|private direction/i);
    wrapper.unmount();
  });

  it.each(['missing', 'ended', 'not-started'])('does not allow direction when the session is %s', state => {
    const current = snapshot();
    if (state === 'missing') current.activeBeat = null;
    if (state === 'ended') current.session.status = 'ended';
    if (state === 'not-started') current.setup = { started: false } as DirectorSnapshot['setup'];
    const wrapper = mount(BeatSteering, { props: { snapshot: current, busy: false } });
    const save = wrapper.find(field('save-beat-steering'));
    expect(!save.exists() || save.attributes('disabled') !== undefined).toBe(true); wrapper.unmount();
  });
});
