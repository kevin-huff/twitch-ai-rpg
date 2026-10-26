// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, loadDraft, saveDraft, type Draft } from './drafts';

const draft = (over: Partial<Draft> = {}): Draft => ({ kind: 'say', speech: 'Hello there', intent: '', approach: '', note: '', stageDirection: '', recipient: 'npc-1', context: { epoch: 2, beatId: 'beat-1' }, ...over });

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('drafts', () => {
  it('saves, loads and clears a draft with its input context', () => {
    saveDraft('show', 'pc-1', draft());
    expect(loadDraft('show', 'pc-1')).toEqual(draft());
    clearDraft('show', 'pc-1');
    expect(loadDraft('show', 'pc-1')).toBeNull();
  });

  it('keeps one draft per session and character', () => {
    saveDraft('show', 'pc-1', draft({ speech: 'One' }));
    saveDraft('show', 'pc-2', draft({ speech: 'Two' }));
    saveDraft('other', 'pc-1', draft({ speech: 'Three' }));
    expect(loadDraft('show', 'pc-1')?.speech).toBe('One');
    expect(loadDraft('show', 'pc-2')?.speech).toBe('Two');
    expect(loadDraft('other', 'pc-1')?.speech).toBe('Three');
  });

  it('does not save a draft whose text fields are blank', () => {
    saveDraft('show', 'pc-1', draft({ speech: '  ', note: '  ', recipient: 'npc-1' }));
    expect(sessionStorage.length).toBe(0);
    expect(loadDraft('show', 'pc-1')).toBeNull();
  });

  it('saves an action draft that only has an intent', () => {
    saveDraft('show', 'pc-1', draft({ kind: 'act', speech: '', intent: 'Open the door', context: null }));
    expect(loadDraft('show', 'pc-1')).toMatchObject({ kind: 'act', intent: 'Open the door', context: null });
  });

  it('saves and loads a private-note draft', () => {
    const note = draft({ kind: 'ooc', speech: '', note: 'Can I step out for a minute?', recipient: '', context: null });
    saveDraft('show', 'pc-1', note);
    expect(loadDraft('show', 'pc-1')).toEqual(note);
  });

  it('loads an older stored draft without a note field with an empty note', () => {
    sessionStorage.setItem('rpg-draft:show:pc-1', JSON.stringify({ kind: 'say', speech: 'Hi', intent: '', approach: '', stageDirection: '', recipient: '', context: null }));
    expect(loadDraft('show', 'pc-1')).toMatchObject({ speech: 'Hi', note: '', legacy: true });
  });

  it('does not mark a current draft as legacy, even with an empty note', () => {
    saveDraft('show', 'pc-1', draft({ kind: 'ooc', speech: 'Who sent you?', note: '' }));
    expect(loadDraft('show', 'pc-1')).not.toHaveProperty('legacy');
  });

  it('ignores stored data that is not a draft', () => {
    sessionStorage.setItem('rpg-draft:show:pc-1', 'not json');
    expect(loadDraft('show', 'pc-1')).toBeNull();
    sessionStorage.setItem('rpg-draft:show:pc-1', JSON.stringify({ kind: 'shout', speech: 'x' }));
    expect(loadDraft('show', 'pc-1')).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => saveDraft('show', 'pc-1', draft())).not.toThrow();
    expect(loadDraft('show', 'pc-1')).toBeNull();
    expect(() => clearDraft('show', 'pc-1')).not.toThrow();
  });
});
