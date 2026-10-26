// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper, type DOMWrapper } from '@vue/test-utils';
import type { Submission } from '@rpg/contracts';
import SubmissionList from './SubmissionList.vue';

function sub(n: number, over: Partial<Submission> = {}): Submission {
  return { id: `s${n}`, sessionId: 'x', characterId: 'c', contextBeatId: null, inputEpoch: 1, revision: n, kind: 'say', text: `Line ${n}`, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'queued', ...over } as Submission;
}
const npcs = [{ id: 'n1', displayName: 'Mara' }] as never[];
const make = (submissions: Submission[]) => mount(SubmissionList, { props: { submissions, npcs, busy: false } });
const buttons = (root: Pick<VueWrapper | DOMWrapper<Element>, 'findAll'>, name: string) => root.findAll('button').filter(b => b.text() === name);

describe('SubmissionList', () => {
  it('lists newest first with only the newest finished line', () => {
    const w = make([
      sub(1, { status: 'published' }), sub(2, { status: 'cancelled' }), sub(3, { status: 'queued' }),
      sub(4, { status: 'selected' }), sub(5, { status: 'locked' }),
    ]);
    expect(w.findAll('.sub-item').map(i => i.attributes('data-status'))).toEqual(['locked', 'selected', 'queued', 'cancelled']);
    expect(w.text()).not.toContain('Show older');
  });

  it('renders nothing for an empty list', () => {
    const w = make([]);
    expect(w.find('.sub-list').exists()).toBe(false);
    expect(w.html()).not.toContain('What you sent');
  });

  it('labels each kind of line', () => {
    const w = make([
      sub(1, { recipientNpcIds: ['n1'] }),
      sub(2),
      sub(3, { kind: 'act', intent: 'Open it', approach: 'Open it', text: '', status: 'locked' }),
      sub(4, { kind: 'act', intent: 'Open the hatch', approach: 'Pick the lock', text: '', status: 'locked' }),
      sub(5, { kind: 'ooc', text: 'Can I pause?' }),
    ]);
    const items = w.findAll('.sub-item'); // newest first: 5,4,3,2,1
    expect(items[0].text()).toContain('Private note');
    expect(items[0].text()).toContain('Can I pause?');
    expect(items[1].text()).toContain('You tried');
    expect(items[1].text()).toContain('Open the hatch');
    const muted = items[1].findAll('p.muted');
    expect(muted).toHaveLength(1);
    expect(muted[0].text()).toBe('Pick the lock');
    expect(items[2].text()).toContain('You tried');
    expect(items[2].text().split('Open it').length - 1).toBe(1);
    expect(items[2].findAll('p.muted')).toHaveLength(0);
    expect(items[3].text()).toContain('You said to your group');
    expect(items[4].text()).toContain('You said to Mara');
    expect(items[4].text()).toContain('Line 1');
  });

  it('shows the status sentence word for word', () => {
    const expected: Record<string, string> = {
      queued: 'Sent. Waiting for the director to pick lines.',
      selected: 'Picked by the director. You can still change it.',
      locked: 'Locked in. Watch the stream to see what happens.',
      published: 'This is in the story now.',
      cancelled: 'Not used. You took it back, or the story moved on. Send it again if it still fits.',
    };
    for (const [status, sentence] of Object.entries(expected)) {
      const w = make([sub(1, { status: status as Submission['status'] })]);
      expect(w.find('.sentence').text()).toBe(sentence);
    }
  });

  it('keeps only the newest private note, with its own sentence', () => {
    const w = make([sub(1, { kind: 'ooc', text: 'Old note' }), sub(2), sub(3, { kind: 'ooc', text: 'Pause requested. Please check in with the table.' })]);
    const items = w.findAll('.sub-item');
    expect(items.map(i => i.attributes('data-status'))).toEqual(['queued', 'queued']);
    expect(items[0].text()).toContain('Private note');
    expect(items[0].find('.sentence').text()).toBe('Sent. Only the director sees it.');
    expect(items[1].find('.sentence').text()).toBe('Sent. Waiting for the director to pick lines.');
    expect(w.text()).not.toContain('Old note');
  });

  it('keeps the newest note and the newest finished line apart', () => {
    const w = make([sub(1, { status: 'published' }), sub(2, { status: 'cancelled' }), sub(3, { kind: 'ooc', text: 'Pause requested. Please check in with the table.' })]);
    expect(w.findAll('.sub-item').map(i => i.attributes('data-status'))).toEqual(['queued', 'cancelled']);
    expect(w.text()).toContain('Send it again if it still fits.');
    expect(make([sub(1, { kind: 'ooc', text: 'Old note' }), sub(2, { status: 'published' })]).findAll('.sub-item')).toHaveLength(2);
  });

  it('offers Change and Take it back only on queued and selected lines', () => {
    const w = make([sub(1, { status: 'queued' }), sub(2, { status: 'selected' }), sub(3, { status: 'locked' }), sub(4, { status: 'published' })]);
    const items = w.findAll('.sub-item'); // newest first: 4,3,2,1
    const has = items.map(i => buttons(i, 'Change').length === 1 && buttons(i, 'Take it back').length === 1);
    expect(has).toEqual([false, false, true, true]);
    expect(items[0].findAll('button')).toHaveLength(0);
    expect(items[1].findAll('button')).toHaveLength(0);
  });

  it('needs confirmation before taking a line back', async () => {
    const item = sub(1);
    const w = make([item]);
    await buttons(w, 'Take it back')[0].trigger('click');
    expect(w.emitted('withdraw')).toBeUndefined();
    expect(w.text()).toContain('Take this line back?');
    const confirm = buttons(w, 'Take it back')[0];
    expect(confirm.classes()).toContain('secondary');
    await buttons(w, 'Keep it')[0].trigger('click');
    expect(w.text()).not.toContain('Take this line back?');
    expect(w.emitted('withdraw')).toBeUndefined();
    await buttons(w, 'Take it back')[0].trigger('click');
    await buttons(w, 'Take it back')[0].trigger('click');
    expect(w.emitted('withdraw')).toEqual([[item]]);
  });

  it('emits edit from Change', async () => {
    const item = sub(1);
    const w = make([item]);
    await buttons(w, 'Change')[0].trigger('click');
    expect(w.emitted('edit')).toEqual([[item]]);
  });
});
