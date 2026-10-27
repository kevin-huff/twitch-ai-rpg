import { describe, expect, it } from 'vitest';
import type { PictureMoment, PublishedBeat } from '@rpg/contracts';
import {
  beatLine, captionText, firstSentence, galleryCover, galleryPictures, initials, modelLabel, momentLine, onlyPlaced,
  picturesText, sceneCaption, type GalleryCaptionRow, type GalleryCastMember, type GalleryPicture, type GalleryTag, type GalleryView,
} from '../src/gallery-model';

function beat(id: string, texts: { kind: 'narration' | 'npc_dialogue' | 'player_dialogue' | 'system'; text: string }[], numbers: { beatNumber?: number; actionRoundNumber?: number } = {}): PublishedBeat {
  return {
    id, kind: 'action', beatNumber: numbers.beatNumber ?? 1, actionRoundNumber: numbers.actionRoundNumber ?? 0, stateRevision: 1,
    publishedAt: '2026-10-25T00:00:00.000Z',
    segments: texts.map((item, index) => ({
      id: `${id}-s${index}`, kind: item.kind, text: item.text, speaker: null, recipientCharacterIds: [],
      delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false,
    })),
    rolls: [], outcomes: [], textOnly: true,
  } as unknown as PublishedBeat;
}

function moment(lines: { kind: 'narration' | 'npc_dialogue' | 'player_dialogue' | 'intent' | 'approach' | 'outcome'; text: string }[]): PictureMoment {
  return {
    style: 'Painterly', model: 'krea-2-turbo', scene: { title: 'Dock', description: 'A dock', place: 'Harbor' },
    lines: lines.map(line => ({ ...line, speaker: null })), cast: [], names: [],
  };
}

const published = new Map<string, PublishedBeat>([
  ['round-1', beat('round-1', [{ kind: 'npc_dialogue', text: 'Hello there.' }, { kind: 'narration', text: 'The gate creaks open. Then silence.' }], { beatNumber: 3, actionRoundNumber: 2 })],
  ['beat-7', beat('beat-7', [{ kind: 'player_dialogue', text: 'We go now!' }], { beatNumber: 7, actionRoundNumber: 0 })],
]);

function row(overrides: Partial<GalleryCaptionRow> = {}): GalleryCaptionRow {
  return { status: 'ready', hidden: false, beat_id: null, released_at: null, shows_beat_id: null, moment: null, ...overrides };
}

describe('sceneCaption', () => {
  it('step 1: a replaced row of a published round is an earlier draft with the round line', () => {
    expect(sceneCaption(row({ status: 'cancelled', beat_id: 'round-1', released_at: '2026-10-25T00:00:00Z' }), published)).toEqual({
      label: 'Earlier draft of action round 2', line: 'The gate creaks open.', tag: 'Not shown on stream',
    });
  });

  it('step 1: a replaced row of an unpublished round has no number and no line', () => {
    expect(sceneCaption(row({ status: 'cancelled', beat_id: 'gone' }), published)).toEqual({
      label: 'Earlier draft of a round', line: null, tag: 'Not shown on stream',
    });
  });

  it('step 2: a published round picture that was never released is not shown on stream', () => {
    expect(sceneCaption(row({ beat_id: 'round-1', released_at: null }), published)).toEqual({
      label: 'Action round 2', line: 'The gate creaks open.', tag: 'Not shown on stream',
    });
  });

  it('step 2: a released round picture has no tag, or Hidden when hidden', () => {
    const released = new Date('2026-10-25T01:00:00Z');
    expect(sceneCaption(row({ beat_id: 'round-1', released_at: released }), published).tag).toBeNull();
    expect(sceneCaption(row({ beat_id: 'round-1', released_at: released, hidden: true }), published)).toEqual({
      label: 'Action round 2', line: 'The gate creaks open.', tag: 'Hidden',
    });
  });

  it('tags rule: Not shown on stream wins over Hidden', () => {
    expect(sceneCaption(row({ beat_id: 'round-1', released_at: null, hidden: true }), published).tag).toBe('Not shown on stream');
    expect(sceneCaption(row({ status: 'cancelled', beat_id: 'round-1', hidden: true }), published).tag).toBe('Not shown on stream');
  });

  it('step 3: a round that is not published at all', () => {
    expect(sceneCaption(row({ beat_id: 'missing', released_at: '2026-10-25T00:00:00Z' }), published)).toEqual({
      label: 'A round that was never published', line: null, tag: 'Not shown on stream',
    });
  });

  it('step 4: shows_beat_id found in the published beats', () => {
    expect(sceneCaption(row({ shows_beat_id: 'beat-7' }), published)).toEqual({ label: 'Beat 7', line: 'We go now!', tag: null });
    expect(sceneCaption(row({ shows_beat_id: 'beat-7', hidden: true }), published).tag).toBe('Hidden');
  });

  it('step 4 falls through to the moment when shows_beat_id is not published', () => {
    const m = moment([{ kind: 'narration', text: 'Rain falls.' }]);
    expect(sceneCaption(row({ shows_beat_id: 'unknown', moment: m }), published)).toEqual({ label: 'A beat', line: 'Rain falls.', tag: null });
  });

  it('step 4 falls through to the place when shows_beat_id is unknown and there is no moment', () => {
    expect(sceneCaption(row({ shows_beat_id: 'unknown' }), published).label).toBe('The place');
  });

  it('step 5: an older moment row', () => {
    const m = moment([{ kind: 'player_dialogue', text: 'Run!' }, { kind: 'narration', text: 'They sprint. Fast.' }]);
    expect(sceneCaption(row({ moment: m }), published)).toEqual({ label: 'A beat', line: 'They sprint.', tag: null });
    expect(sceneCaption(row({ moment: m, hidden: true }), published).tag).toBe('Hidden');
  });

  it('step 6: the place, and a hidden place', () => {
    expect(sceneCaption(row(), published)).toEqual({ label: 'The place', line: null, tag: null });
    expect(sceneCaption(row({ hidden: true }), published)).toEqual({ label: 'The place', line: null, tag: 'Hidden' });
  });

  it('a beat_id match wins over shows_beat_id and moment', () => {
    const m = moment([{ kind: 'narration', text: 'Ignored.' }]);
    expect(sceneCaption(row({ beat_id: 'round-1', released_at: new Date(), shows_beat_id: 'beat-7', moment: m }), published).label).toBe('Action round 2');
  });
});

describe('firstSentence', () => {
  it('cuts at the first sentence end', () => {
    expect(firstSentence('It rains. Then')).toBe('It rains.');
    expect(firstSentence('Stop!')).toBe('Stop!');
    expect(firstSentence('Wait... what?')).toBe('Wait...');
    expect(firstSentence('Dr. Vale')).toBe('Dr.');
  });

  it('returns a text with no sentence end whole, trimmed', () => {
    expect(firstSentence('  no end here  ')).toBe('no end here');
  });

  it('gives null for blank text', () => {
    expect(firstSentence('')).toBeNull();
    expect(firstSentence('   \n ')).toBeNull();
  });
});

describe('beatLine and momentLine', () => {
  it('beatLine prefers narration', () => {
    expect(beatLine(published.get('round-1')!)).toBe('The gate creaks open.');
  });

  it('beatLine falls back to the first segment and to null', () => {
    expect(beatLine(published.get('beat-7')!)).toBe('We go now!');
    expect(beatLine(beat('empty', []))).toBeNull();
  });

  it('momentLine prefers narration, falls back to the first line, and gives null without lines', () => {
    expect(momentLine(moment([{ kind: 'intent', text: 'Hide.' }, { kind: 'narration', text: 'Night falls. Cold.' }]))).toBe('Night falls.');
    expect(momentLine(moment([{ kind: 'intent', text: 'Hide now. Quietly.' }]))).toBe('Hide now.');
    expect(momentLine(moment([]))).toBeNull();
  });
});

describe('modelLabel', () => {
  it('uses the label of a listed model and the id of an unknown one', () => {
    expect(modelLabel('flux-3-klein')).toBe('FLUX 3 Klein');
    expect(modelLabel('mystery-model')).toBe('mystery-model');
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Mara Vale')).toBe('MV');
    expect(initials('nia')).toBe('N');
    expect(initials('')).toBe('?');
    expect(initials('  ')).toBe('?');
    expect(initials('ann bea cat')).toBe('AB');
  });
});

describe('captionText and picturesText', () => {
  it('builds the caption from label, line and tag', () => {
    expect(captionText({ label: 'The place', line: null, tag: null })).toBe('The place');
    expect(captionText({ label: 'Beat 2', line: 'It rains.', tag: null })).toBe('Beat 2 “It rains.”');
    expect(captionText({ label: 'Beat 2', line: null, tag: 'Hidden' })).toBe('Beat 2 · Hidden');
    expect(captionText({ label: 'Action round 1', line: 'Go.', tag: 'Not shown on stream' })).toBe('Action round 1 “Go.” · Not shown on stream');
  });

  it('counts pictures', () => {
    expect(picturesText(1)).toBe('1 picture');
    expect(picturesText(3)).toBe('3 pictures');
    expect(picturesText(0)).toBe('0 pictures');
  });
});

function picture(id: string): GalleryPicture {
  return {
    id, file: `${id}.jpg`, fileHash: id.padEnd(64, '0'), contentType: 'image/jpeg', width: 768, height: 768,
    label: id, line: null, tag: null, model: 'Krea 2 Turbo', prompt: `prompt ${id}`,
  };
}

function member(kind: 'player' | 'npc', name: string, portrait: GalleryPicture | null): GalleryCastMember {
  return { kind, name, initials: initials(name), portrait };
}

function sampleView(): GalleryView {
  const view: GalleryView = {
    sessionId: 's1', title: 'Show', endedAt: null,
    cast: [member('player', 'Mara Vale', picture('p1')), member('player', 'Nia', null), member('npc', 'Captain', picture('n1')), member('npc', 'Guard', picture('n2'))],
    scenes: [
      { number: 1, title: 'Dock', pictures: [picture('a1'), picture('a2')] },
      { number: 2, title: 'Gate', pictures: [picture('b1')] },
      { number: 3, title: 'Hall', pictures: [picture('c1')] },
    ],
    morePortraits: [{ name: 'Captain', pictures: [picture('n1'), picture('m1')] }, { name: 'Guard', pictures: [picture('m2')] }],
    pending: 2, cover: null,
  };
  view.cover = galleryCover(view);
  return view;
}

describe('galleryPictures and galleryCover', () => {
  it('lists every picture once in page order', () => {
    expect(galleryPictures(sampleView()).map(item => item.id)).toEqual(['p1', 'n1', 'n2', 'a1', 'a2', 'b1', 'c1', 'm1', 'm2']);
  });

  it('picks the first scene picture as the cover, then a cast portrait, then a more portrait, else null', () => {
    const view = sampleView();
    expect(galleryCover(view)?.id).toBe('a1');
    expect(galleryCover({ ...view, scenes: [] })?.id).toBe('p1');
    expect(galleryCover({ ...view, scenes: [], cast: [member('player', 'Nia', null)] })?.id).toBe('n1');
    expect(galleryCover({ ...view, scenes: [], cast: [], morePortraits: [] })).toBeNull();
  });
});

describe('galleryCover and tagged pictures', () => {
  const tagged = (id: string, tag: GalleryTag): GalleryPicture => ({ ...picture(id), tag });

  it('skips a tagged first scene picture for a later untagged one', () => {
    const view = sampleView();
    view.scenes = [{ number: 1, title: 'Dock', pictures: [tagged('a1', 'Hidden'), picture('a2')] }];
    expect(galleryCover(view)?.id).toBe('a2');
    view.scenes = [
      { number: 1, title: 'Dock', pictures: [tagged('a1', 'Hidden')] },
      { number: 2, title: 'Gate', pictures: [tagged('b1', 'Not shown on stream'), picture('b2')] },
    ];
    expect(galleryCover(view)?.id).toBe('b2');
  });

  it('falls back to the first cast portrait, then More portraits, when every scene picture is tagged', () => {
    const view = sampleView();
    view.scenes = [{ number: 1, title: 'Dock', pictures: [tagged('a1', 'Hidden'), tagged('a2', 'Not shown on stream')] }];
    expect(galleryCover(view)?.id).toBe('p1');
    expect(galleryCover({ ...view, cast: [member('player', 'Nia', null)] })?.id).toBe('n1');
  });

  it('gives null when everything is tagged and there are no portraits', () => {
    const view = sampleView();
    view.scenes = [{ number: 1, title: 'Dock', pictures: [tagged('a1', 'Hidden')] }];
    expect(galleryCover({ ...view, cast: [], morePortraits: [] })).toBeNull();
  });

  it('onlyPlaced recomputes the cover with the same rule', () => {
    const view = sampleView();
    view.scenes = [{ number: 1, title: 'Dock', pictures: [tagged('a1', 'Hidden'), picture('a2')] }];
    expect(onlyPlaced(view, new Set(['a1', 'a2', 'p1'])).cover?.id).toBe('a2');
    expect(onlyPlaced(view, new Set(['a1', 'p1'])).cover?.id).toBe('p1');
    expect(onlyPlaced(view, new Set(['a1'])).cover).toBeNull();
  });
});

describe('onlyPlaced', () => {
  it('drops unplaced pictures, keeps players without portraits, drops npcs without portraits', () => {
    const result = onlyPlaced(sampleView(), new Set(['a1', 'b1', 'n1', 'm2']));
    expect(result.cast.map(item => [item.name, item.portrait?.id ?? null])).toEqual([['Mara Vale', null], ['Nia', null], ['Captain', 'n1']]);
    expect(result.scenes.map(scene => [scene.number, scene.pictures.map(item => item.id)])).toEqual([[1, ['a1']], [2, ['b1']]]);
    expect(result.morePortraits.map(group => [group.name, group.pictures.map(item => item.id)])).toEqual([['Captain', ['n1']], ['Guard', ['m2']]]);
  });

  it('drops empty scenes but keeps the numbers of the rest', () => {
    const result = onlyPlaced(sampleView(), new Set(['c1']));
    expect(result.scenes).toEqual([{ number: 3, title: 'Hall', pictures: [expect.objectContaining({ id: 'c1' })] }]);
  });

  it('recomputes the cover', () => {
    expect(onlyPlaced(sampleView(), new Set(['b1', 'a1'])).cover?.id).toBe('a1');
    expect(onlyPlaced(sampleView(), new Set(['b1'])).cover?.id).toBe('b1');
    expect(onlyPlaced(sampleView(), new Set(['n1'])).cover?.id).toBe('n1');
    expect(onlyPlaced(sampleView(), new Set(['m1'])).cover?.id).toBe('m1');
    expect(onlyPlaced(sampleView(), new Set()).cover).toBeNull();
  });

  it('keeps the other fields and leaves the input unchanged', () => {
    const view = sampleView();
    const snapshot = structuredClone(view);
    const result = onlyPlaced(view, new Set(['a1']));
    expect(view).toEqual(snapshot);
    expect(result).not.toBe(view);
    expect(result.title).toBe('Show');
    expect(result.pending).toBe(2);
    expect(result.sessionId).toBe('s1');
  });
});
