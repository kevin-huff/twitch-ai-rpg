// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { PICTURE_MODELS } from '@rpg/contracts';
import type { DirectorSnapshot } from '@rpg/contracts';
import ScenePicturePanel from './ScenePicturePanel.vue';

const imageId = '11111111-1111-4111-8111-111111111111';

function snapshot(overrides: Record<string, unknown> = {}, statusOverrides: Record<string, unknown> | null = {}, session: Record<string, unknown> = {}): DirectorSnapshot {
  return {
    schemaVersion: 1, role: 'director', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: '', locationId: 'bar' }, ...session },
    characters: [], npcs: [], tracks: [], facts: [], history: [], corrections: [], activeBeat: null, submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: '', locations: [],
    picturesEnabled: true, scenePicture: null, portraitJobs: [], pictureSettings: null, lastSceneBeatId: 'beat-one',
    scenePictureStatus: statusOverrides === null ? null : { sceneId: 'bar', state: 'none', imageId: null, hidden: false, message: null, ...statusOverrides },
    ...overrides,
  } as unknown as DirectorSnapshot;
}
const FieldGeneratorStub = { props: ['field', 'modelValue', 'contextKey', 'disabled', 'premise', 'premiseLabel'], template: '<button type="button" class="generator-stub" :disabled="disabled">AI Generate</button>' };
const mountPanel = (snap: DirectorSnapshot, busy = false) => mount(ScenePicturePanel, { props: { snapshot: snap, busy }, global: { stubs: { FieldGenerator: FieldGeneratorStub } } });
const button = (w: ReturnType<typeof mountPanel>, id: string) => w.find(`[data-testid="scene-picture-${id}"]`);
const line = (w: ReturnType<typeof mountPanel>) => w.get('[data-testid="scene-picture-status"]').text();
const helpLine = (w: ReturnType<typeof mountPanel>) => w.get('.scene-picture-help').text();

const OFF = 'Pictures are off on this server.';
const NONE = 'This scene has no picture yet. Press Draw the place to make one.';
const HELP = "Draw the place makes a new picture of this scene's place. Draw the last beat draws the newest beat in this scene, with everyone who took part. Pressing either one while a picture is on its way starts over. The new picture takes the old one's place when it is ready.";
const NO_BEAT = 'No beat has been published in this scene yet.';
const SHOWN = 'This picture is on the stream and the player seats.';
const HIDDEN = 'This picture is hidden. Viewers and players do not see it. Press Show picture to put it back.';

describe('ScenePicturePanel', () => {
  it('shows only the off sentence and no buttons when pictures are off', () => {
    const w = mountPanel(snapshot({ picturesEnabled: false }, null));
    expect(w.get('.eyebrow').text()).toBe('Scene picture');
    expect(line(w)).toBe(OFF);
    expect(w.findAll('button')).toHaveLength(0);
    expect(w.find('img').exists()).toBe(false);
    expect(w.text()).not.toContain('Draw the place makes');
  });

  it('says there is no picture yet when the scene has none, with a status of none or no status', () => {
    for (const snap of [snapshot(), snapshot({}, null)]) {
      const w = mountPanel(snap);
      expect(line(w)).toBe(NONE);
      expect(button(w, 'new').text()).toBe('Draw the place');
      expect(button(w, 'beat').text()).toBe('Draw the last beat');
      expect(button(w, 'new').attributes('disabled')).toBeUndefined();
      expect(button(w, 'hide').exists()).toBe(false);
      expect(button(w, 'show').exists()).toBe(false);
      expect(w.find('img').exists()).toBe(false);
      expect(helpLine(w)).toBe(HELP);
    }
  });

  it('keeps the old picture visible while a new one is being made and leaves both draw buttons on', () => {
    const w = mountPanel(snapshot({}, { state: 'making', imageId }));
    expect(line(w)).toBe('Making the picture...');
    expect(button(w, 'new').attributes('disabled')).toBeUndefined();
    expect(button(w, 'beat').attributes('disabled')).toBeUndefined();
    expect(button(w, 'hide').exists()).toBe(true);
    const img = w.get('img.scene-picture-preview');
    expect(img.attributes('src')).toBe(`/api/sessions/show/images/${imageId}`);
    expect(img.attributes('alt')).toBe('The Velvet Static');
  });

  it('shows the stored message when the picture failed, or a default', () => {
    expect(line(mountPanel(snapshot({}, { state: 'failed', message: 'The picture service is out of credit.' })))).toBe('The picture service is out of credit.');
    const w = mountPanel(snapshot({}, { state: 'failed', message: null }));
    expect(line(w)).toBe('The picture could not be made. Press Draw the place to try again.');
    expect(button(w, 'new').attributes('disabled')).toBeUndefined();
    expect(button(w, 'hide').exists()).toBe(false);
    expect(button(w, 'show').exists()).toBe(false);
  });

  it('adds that the scene stays hidden when a failed picture is hidden', () => {
    const suffix = ' The scene stays hidden until you press Show picture.';
    expect(line(mountPanel(snapshot({}, { state: 'failed', hidden: true, message: null })))).toBe('The picture could not be made. Press Draw the place to try again.' + suffix);
    const limit = 'The picture limit for this hour is used up. Try again in 12 minutes.';
    expect(line(mountPanel(snapshot({}, { state: 'failed', hidden: true, message: limit })))).toBe(limit + suffix);
  });

  it('drops the try-again advice once the show has ended', () => {
    for (const message of [null, 'The picture service is out of credit.']) {
      const w = mountPanel(snapshot({}, { state: 'failed', message }, { status: 'ended' }));
      expect(line(w)).toBe('The picture could not be made.');
      expect(button(w, 'new').attributes('disabled')).toBeDefined();
    }
    const hidden = mountPanel(snapshot({}, { state: 'failed', hidden: true, message: 'The picture service is out of credit.' }, { status: 'ended' }));
    expect(line(hidden)).toBe('The picture could not be made. The scene stays hidden until you press Show picture.');
  });

  it('says a shown picture is on the stream and offers Hide picture', () => {
    const w = mountPanel(snapshot({}, { state: 'ready', imageId }));
    expect(line(w)).toBe(SHOWN);
    expect(button(w, 'hide').text()).toBe('Hide picture');
    expect(button(w, 'show').exists()).toBe(false);
    expect(w.find('img.scene-picture-preview').exists()).toBe(true);
  });

  it('says a hidden picture is hidden and offers Show picture instead of Hide picture', () => {
    const w = mountPanel(snapshot({}, { state: 'ready', imageId, hidden: true }));
    expect(line(w)).toBe(HIDDEN);
    expect(button(w, 'show').text()).toBe('Show picture');
    expect(button(w, 'hide').exists()).toBe(false);
    expect(w.find('img.scene-picture-preview').exists()).toBe(true);
  });

  it('disables the draw buttons while the director is busy but leaves Hide picture and Show picture enabled', async () => {
    const w = mountPanel(snapshot({}, { state: 'ready', imageId }), true);
    expect(button(w, 'new').attributes('disabled')).toBeDefined();
    expect(button(w, 'beat').attributes('disabled')).toBeDefined();
    expect(button(w, 'hide').attributes('disabled')).toBeUndefined();
    await button(w, 'hide').trigger('click');
    expect(w.emitted('hide')).toHaveLength(1);
    const hidden = mountPanel(snapshot({}, { state: 'ready', imageId, hidden: true }), true);
    expect(button(hidden, 'show').attributes('disabled')).toBeUndefined();
    await button(hidden, 'show').trigger('click');
    expect(hidden.emitted('show')).toHaveLength(1);
  });

  it('disables Hide picture and Show picture while a toggle is in flight', async () => {
    const shown = mount(ScenePicturePanel, { props: { snapshot: snapshot({}, { state: 'ready', imageId }), busy: false, toggling: true }, global: { stubs: { FieldGenerator: FieldGeneratorStub } } });
    expect(button(shown, 'hide').attributes('disabled')).toBeDefined();
    const hidden = mount(ScenePicturePanel, { props: { snapshot: snapshot({}, { state: 'ready', imageId, hidden: true }), busy: false, toggling: true }, global: { stubs: { FieldGenerator: FieldGeneratorStub } } });
    expect(button(hidden, 'show').attributes('disabled')).toBeDefined();
    await button(shown, 'hide').trigger('click');
    expect(shown.emitted('hide')).toBeUndefined();
  });

  it('allows Draw the place only while the show is live or paused and has started', () => {
    for (const status of ['live', 'paused']) expect(button(mountPanel(snapshot({}, {}, { status })), 'new').attributes('disabled')).toBeUndefined();
    for (const status of ['lobby', 'ended']) expect(button(mountPanel(snapshot({}, {}, { status })), 'new').attributes('disabled')).toBeDefined();
    const setup = (started: boolean) => ({ setup: { started } });
    expect(button(mountPanel(snapshot(setup(false))), 'new').attributes('disabled')).toBeDefined();
    expect(button(mountPanel(snapshot(setup(true))), 'new').attributes('disabled')).toBeUndefined();
  });

  describe('Draw the last beat', () => {
    it('is enabled when the show is live or paused, started, idle and a beat exists', () => {
      for (const status of ['live', 'paused']) {
        const w = mountPanel(snapshot({}, {}, { status }));
        expect(button(w, 'beat').attributes('disabled')).toBeUndefined();
        expect(w.find('[data-testid="scene-picture-beat-reason"]').exists()).toBe(false);
      }
    });

    it('is disabled with the reason when the scene has no published beat', () => {
      const w = mountPanel(snapshot({ lastSceneBeatId: null }));
      expect(button(w, 'beat').attributes('disabled')).toBeDefined();
      expect(w.get('[data-testid="scene-picture-beat-reason"]').text()).toBe(NO_BEAT);
      expect(button(w, 'new').attributes('disabled')).toBeUndefined();
      expect(button(mountPanel(snapshot({ lastSceneBeatId: 'beat-two' })), 'beat').attributes('disabled')).toBeUndefined();
    });

    it('is disabled in the lobby, before the show starts, when ended and when busy', () => {
      for (const [overrides, session] of [[{}, { status: 'lobby' }], [{ setup: { started: false } }, {}], [{}, { status: 'ended' }]] as const) {
        const w = mountPanel(snapshot(overrides, {}, session));
        expect(button(w, 'beat').attributes('disabled')).toBeDefined();
        expect(w.find('[data-testid="scene-picture-beat-reason"]').exists()).toBe(false);
      }
      expect(button(mountPanel(snapshot(), true), 'beat').attributes('disabled')).toBeDefined();
    });

    it('stays enabled while a place or beat picture is being made', () => {
      for (const drawing of ['place', 'beat', null]) expect(button(mountPanel(snapshot({}, { state: 'making', imageId, drawing })), 'beat').attributes('disabled')).toBeUndefined();
    });

    it('says the last beat is being drawn, with the hidden suffix when hidden', () => {
      expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null, drawing: 'beat' })))).toBe('Drawing the last beat…');
      expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null, drawing: 'beat', hidden: true })))).toBe('Drawing the last beat… It stays hidden until you press Show picture.');
      expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null, drawing: 'place' })))).toBe('Making the picture...');
      expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null, drawing: 'place', hidden: true })))).toBe('Making the picture... It stays hidden until you press Show picture.');
    });

    it('emits draw-beat', async () => {
      const w = mountPanel(snapshot());
      await button(w, 'beat').trigger('click');
      expect(w.emitted('draw-beat')).toHaveLength(1);
      expect(w.emitted('new-picture')).toBeUndefined();
    });
  });

  describe('picture settings fold-out', () => {
    const settings = { style: 'Old style', model: PICTURE_MODELS[0]!.id };

    it('is shown only when pictures are on and the snapshot carries settings', () => {
      expect(mountPanel(snapshot({ pictureSettings: settings })).find('[data-testid="picture-settings"]').exists()).toBe(true);
      expect(mountPanel(snapshot()).find('[data-testid="picture-settings"]').exists()).toBe(false);
      expect(mountPanel(snapshot({ picturesEnabled: false, pictureSettings: settings }, null)).find('[data-testid="picture-settings"]').exists()).toBe(false);
    });

    it('re-emits its save as save-settings', async () => {
      const w = mountPanel(snapshot({ pictureSettings: settings }));
      await w.get('[data-testid="picture-style"]').setValue('New style');
      await w.get('[data-testid="picture-settings-save"]').trigger('click');
      expect(w.emitted('save-settings')).toEqual([[{ style: 'New style', model: settings.model }]]);
    });

    it('passes the premise, its label and the disabled state down', async () => {
      const brief = { premise: 'A heist at sea' };
      const w = mountPanel(snapshot({ pictureSettings: settings }, {}, { brief }));
      const generator = w.getComponent(FieldGeneratorStub);
      expect(generator.props('premise')).toBe('A heist at sea');
      expect(generator.props('premiseLabel')).toBe('Show scenario: The Ledger Job');
      expect(generator.props('disabled')).toBe(false);
      for (const [snap, busy] of [[snapshot({ pictureSettings: settings }), true], [snapshot({ pictureSettings: settings }, {}, { status: 'ended' }), false]] as const) {
        await w.setProps({ snapshot: snap, busy });
        expect(w.getComponent(FieldGeneratorStub).props('disabled')).toBe(true);
      }
    });
  });

  it('falls back to no preview when the image fails to load, and tries a new picture again', async () => {
    const w = mountPanel(snapshot({}, { state: 'ready', imageId }));
    await w.get('img').trigger('error');
    expect(w.find('img').exists()).toBe(false);
    await w.setProps({ snapshot: snapshot({}, { state: 'ready', imageId: '22222222-2222-4222-8222-222222222222' }) });
    expect(w.find('img').exists()).toBe(true);
  });

  it('shows Hide picture while a new picture is made over an older ready one, and Show picture when hidden', () => {
    expect(button(mountPanel(snapshot({}, { state: 'making', imageId })), 'hide').text()).toBe('Hide picture');
    expect(button(mountPanel(snapshot({}, { state: 'ready', imageId, hidden: true })), 'show').text()).toBe('Show picture');
    expect(button(mountPanel(snapshot({}, { state: 'failed', imageId: null })), 'hide').exists()).toBe(false);
  });

  it('offers Hide picture while making with no finished picture, but not when failed with none', () => {
    expect(button(mountPanel(snapshot({}, { state: 'making', imageId: null })), 'hide').text()).toBe('Hide picture');
    const failed = mountPanel(snapshot({}, { state: 'failed', imageId: null }));
    expect(button(failed, 'hide').exists()).toBe(false);
    expect(button(failed, 'show').exists()).toBe(false);
  });

  it('offers Show picture whenever hidden, including failed and making, with no Hide picture', () => {
    for (const state of ['failed', 'making']) {
      const w = mountPanel(snapshot({}, { state, imageId: null, hidden: true }));
      expect(button(w, 'show').text()).toBe('Show picture');
      expect(button(w, 'hide').exists()).toBe(false);
    }
  });

  it('says a hidden picture being made stays hidden until Show picture', () => {
    expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null, hidden: true })))).toBe('Making the picture... It stays hidden until you press Show picture.');
    expect(line(mountPanel(snapshot({}, { state: 'making', imageId: null })))).toBe('Making the picture...');
  });

  it('says an ended show with no picture has no picture and disables Draw the place', () => {
    const w = mountPanel(snapshot({}, {}, { status: 'ended' }));
    expect(line(w)).toBe('This scene has no picture.');
    expect(button(w, 'new').attributes('disabled')).toBeDefined();
  });

  it('says the picture is made when the show starts, before the show has started', () => {
    const NOT_YET = 'The picture is made when the show starts.';
    const lobby = mountPanel(snapshot({}, {}, { status: 'lobby' }));
    expect(line(lobby)).toBe(NOT_YET);
    expect(button(lobby, 'new').attributes('disabled')).toBeDefined();
    const setup = { setup: { started: false } };
    expect(line(mountPanel(snapshot(setup)))).toBe(NOT_YET);
    expect(line(mountPanel(snapshot({ setup: { started: true } })))).toBe(NONE);
    expect(line(mountPanel(snapshot()))).toBe(NONE);
  });

  it('emits new-picture, hide and show', async () => {
    const w = mountPanel(snapshot({}, { state: 'ready', imageId }));
    await button(w, 'new').trigger('click');
    await button(w, 'hide').trigger('click');
    await w.setProps({ snapshot: snapshot({}, { state: 'ready', imageId, hidden: true }) });
    await button(w, 'show').trigger('click');
    expect(w.emitted('new-picture')).toHaveLength(1);
    expect(w.emitted('hide')).toHaveLength(1);
    expect(w.emitted('show')).toHaveLength(1);
  });

  describe('action picture', () => {
    const beatId = 'beat-one';
    const MAKING = 'Making the picture for this action round. Viewers and players see it when you publish the round.';
    const MAKING_HIDDEN = 'Making the picture for this action round. It stays hidden until you press Show picture.';
    const READY = 'The picture for this action round is ready. Viewers and players see it when you publish the round.';
    const READY_HIDDEN = 'The picture for this action round is ready. It stays hidden until you press Show picture.';
    const FAILED = 'The picture for this action round could not be made. You can still publish the round, and the stream keeps the picture it has now.';
    const action = (state: string, extra: Record<string, unknown> = {}) => ({ beatId, state, imageId: null, message: null, ...extra });
    const actionLine = (w: ReturnType<typeof mountPanel>) => w.get('[data-testid="action-picture-status"]').text();

    it('shows each of the five lines', () => {
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('making') })))).toBe(MAKING);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('making') }, { hidden: true })))).toBe(MAKING_HIDDEN);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('ready', { imageId }) })))).toBe(READY);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('ready', { imageId }) }, { hidden: true })))).toBe(READY_HIDDEN);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('failed') })))).toBe(FAILED);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('failed') }, { hidden: true })))).toBe(FAILED);
    });

    it('places the status after the scene status line', () => {
      const w = mountPanel(snapshot({ actionPicture: action('making') }));
      const ids = w.findAll('[role="status"]').map((n) => n.attributes('data-testid'));
      expect(ids).toEqual(['scene-picture-status', 'action-picture-status']);
    });

    it('shows the preview only when ready, with the session image URL', () => {
      expect(mountPanel(snapshot({ actionPicture: action('making') })).find('[data-testid="action-picture-preview"]').exists()).toBe(false);
      expect(mountPanel(snapshot({ actionPicture: action('failed') })).find('[data-testid="action-picture-preview"]').exists()).toBe(false);
      const img = mountPanel(snapshot({ actionPicture: action('ready', { imageId }) })).get('[data-testid="action-picture-preview"]');
      expect(img.attributes('src')).toBe(`/api/sessions/show/images/${imageId}`);
      expect(img.attributes('alt')).toBe('Picture for this action round');
    });

    it('removes the preview after a load error and tries again for a new picture', async () => {
      const w = mountPanel(snapshot({ actionPicture: action('ready', { imageId }) }));
      await w.get('[data-testid="action-picture-preview"]').trigger('error');
      expect(w.find('[data-testid="action-picture-preview"]').exists()).toBe(false);
      await w.setProps({ snapshot: snapshot({ actionPicture: action('ready', { imageId: '22222222-2222-4222-8222-222222222222' }) }) });
      expect(w.find('[data-testid="action-picture-preview"]').exists()).toBe(true);
    });

    it('has no block when there is no action picture or pictures are off', () => {
      expect(mountPanel(snapshot({ actionPicture: null })).find('[data-testid="action-picture"]').exists()).toBe(false);
      expect(mountPanel(snapshot()).find('[data-testid="action-picture"]').exists()).toBe(false);
      expect(mountPanel(snapshot({ picturesEnabled: false, actionPicture: action('making') }, null)).find('[data-testid="action-picture"]').exists()).toBe(false);
    });

    it('leaves the scene line and Draw the place alone while the action picture is making', () => {
      const w = mountPanel(snapshot({ actionPicture: action('making') }));
      expect(line(w)).toBe(NONE);
      expect(button(w, 'new').attributes('disabled')).toBeUndefined();
    });

    it('shows Hide picture for a held making or ready action picture with no released picture', () => {
      for (const state of ['making', 'ready']) {
        const w = mountPanel(snapshot({ actionPicture: action(state, { imageId: state === 'ready' ? imageId : null }) }));
        expect(button(w, 'hide').exists()).toBe(true);
        expect(button(w, 'show').exists()).toBe(false);
      }
    });

    it('has no Hide picture for a failed action picture with no released picture', () => {
      const w = mountPanel(snapshot({ actionPicture: action('failed') }));
      expect(button(w, 'hide').exists()).toBe(false);
    });

    it('shows the stored failure message, or the fixed sentence when there is none', () => {
      const stored = 'The picture service is out of credit.';
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('failed', { message: stored }) })))).toBe(stored);
      expect(actionLine(mountPanel(snapshot({ actionPicture: action('failed', { message: null }) })))).toBe(FAILED);
    });

    it('emits hide when Hide picture is pressed for a held action picture', async () => {
      const w = mountPanel(snapshot({ actionPicture: action('making') }));
      await button(w, 'hide').trigger('click');
      expect(w.emitted('hide')).toHaveLength(1);
    });
  });
});
