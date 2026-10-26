import { describe, expect, it } from 'vitest';
import { DEFAULT_PICTURE_STYLE, PICTURE_MODELS } from '@rpg/contracts';
import { effectivePictureSettings, scenarioPictureSettings } from '../src/picture-settings';

const LISTED = PICTURE_MODELS[1]!.id;
const FALLBACK = 'fake-image';

describe('effectivePictureSettings', () => {
  it('prefers the saved style, then the brief style, then the default style', () => {
    expect(effectivePictureSettings({ style: 'Saved', model: null }, 'Brief', FALLBACK).style).toBe('Saved');
    expect(effectivePictureSettings({ style: '', model: null }, 'Brief', FALLBACK).style).toBe('Brief');
    expect(effectivePictureSettings({ style: '   ', model: null }, 'Brief', FALLBACK).style).toBe('Brief');
    expect(effectivePictureSettings({ style: '', model: null }, '  ', FALLBACK).style).toBe(DEFAULT_PICTURE_STYLE);
    expect(effectivePictureSettings(null, undefined, FALLBACK).style).toBe(DEFAULT_PICTURE_STYLE);
  });

  it('tidies trailing periods the way pictureStyleOf does', () => {
    expect(effectivePictureSettings({ style: 'Saved style.', model: null }, undefined, FALLBACK).style).toBe('Saved style');
    expect(effectivePictureSettings(null, 'Brief style..', FALLBACK).style).toBe('Brief style');
  });

  it('uses a listed saved model and falls back to the default otherwise', () => {
    expect(effectivePictureSettings({ style: '', model: LISTED }, undefined, FALLBACK).model).toBe(LISTED);
    expect(effectivePictureSettings({ style: '', model: 'not-a-model' }, undefined, FALLBACK).model).toBe(FALLBACK);
    expect(effectivePictureSettings({ style: '', model: null }, undefined, FALLBACK).model).toBe(FALLBACK);
    expect(effectivePictureSettings({ style: 'x' }, undefined, FALLBACK).model).toBe(FALLBACK);
  });

  it('treats malformed saved values as missing', () => {
    const defaults = { style: DEFAULT_PICTURE_STYLE, model: FALLBACK };
    for (const bad of [null, undefined, 'text', 42, true, [], ['style'], {}, { style: 5, model: 7 }, { style: null, model: null }]) {
      expect(effectivePictureSettings(bad, undefined, FALLBACK)).toEqual(defaults);
    }
  });

  it('reads each field leniently when only the other is malformed', () => {
    expect(effectivePictureSettings({ style: 5, model: LISTED }, 'Brief', FALLBACK)).toEqual({ style: 'Brief', model: LISTED });
    expect(effectivePictureSettings({ style: 'Saved', model: 5 }, undefined, FALLBACK)).toEqual({ style: 'Saved', model: FALLBACK });
  });
});

describe('scenarioPictureSettings', () => {
  it('returns the trimmed style and chosen model', () => {
    expect(scenarioPictureSettings({ pictureStyle: '  Ink  ', pictureModel: LISTED })).toEqual({ style: 'Ink', model: LISTED });
  });

  it('returns an empty style and no model without choices', () => {
    expect(scenarioPictureSettings({})).toEqual({ style: '', model: null });
    expect(scenarioPictureSettings({ pictureStyle: '   ' })).toEqual({ style: '', model: null });
  });
});
