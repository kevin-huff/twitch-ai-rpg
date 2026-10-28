// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HelpPage from './HelpPage.vue';
import { firstSteps, glossary, topics } from './help/content';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const countWords = (topic: (typeof topics)[number]) =>
  topic.sections.flatMap(section => [section.heading, ...(section.paragraphs ?? []), ...(section.steps ?? [])]).join(' ').split(/\s+/).filter(Boolean).length;

beforeEach(() => {
  try { window.sessionStorage.clear(); } catch { /* nothing stored */ }
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  try { window.localStorage.clear(); } catch { /* nothing stored */ }
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

describe('help page', () => {
  const anchors = ['getting-started', 'running-a-show', 'scenarios-and-characters', 'producers', 'players', 'stage-and-obs', 'streaming-your-own-obs', 'pictures-and-portraits', 'glossary', 'troubleshooting'];
  const terms = [
    'beat', 'conversation', 'action round', 'what\'s at risk', 'contract', 'ruling', 'trait', 'risk', 'Edge', 'outcome bands', 'critical failure', 'strain', 'track',
    'facts to remember', 'note for the AI', 'input window', 'presenter', 'Listen', 'text-only beat', 'test seat', 'host', 'director', 'producer', 'boundaries',
    'stage', 'scene layout', 'overlay layout', 'stream link', 'character card', 'character link',
  ];

  it('renders each of the ten anchors once, in order', () => {
    const wrapper = mount(HelpPage);
    for (const id of anchors) expect(wrapper.findAll(`section#${id}`)).toHaveLength(1);
    expect(wrapper.findAll('.help-page > section[id]').map(section => section.attributes('id'))).toEqual(anchors);
    expect(wrapper.get('h1').text()).toBe('Help');
  });

  it('quotes the picture labels and messages', () => {
    const text = mount(HelpPage).get('section#pictures-and-portraits').text();
    for (const label of [
      'Create portrait', 'Try again', 'Use this portrait', 'Remove portrait', 'Draw the place', 'Draw the last beat', 'Hide picture', 'Show picture',
      'Create portraits for everyone', 'Picture style', 'Making the picture...', 'Pictures are off on this server',
      'The picture could not be made. Press Draw the place to try again.',
      'The picture service would not draw this scene. Press Draw the place to try again.',
      'The picture of the last beat could not be made. Press Draw the last beat to try again.',
      'The picture service would not draw this beat. Press Draw the last beat to try again.',
      'Picture settings', 'Art style', 'Picture model', 'Save picture settings', 'Server default', 'Drawing the last beat…',
      'No beat has been published in this scene yet.',
      'Pictures of a beat use FLUX 3 Klein when anyone in them has a portrait, because it is the only model that can draw your cast from their portraits.',
      'Painterly digital illustration, rich color, cinematic lighting',
      'Making the picture for this action round. Viewers and players see it when you publish the round.',
      'The picture for this action round is ready. Viewers and players see it when you publish the round.',
      'The picture for this action round could not be made. You can still publish the round, and the stream keeps the picture it has now.',
      'Pictures are busy right now. Try again in a minute.',
      'The picture limit for this hour is used up. Try again in 12 minutes.',
    ]) expect(text).toContain(label);
  });

  it('lists every glossary term', () => {
    const listed = glossary.map(item => item.term.toLowerCase());
    for (const term of terms) expect(listed).toContain(term.toLowerCase());
    expect(glossary.every(item => item.definition.length > 20)).toBe(true);
    const wrapper = mount(HelpPage);
    const shown = wrapper.findAll('section#glossary dt').map(node => node.text().toLowerCase());
    for (const term of terms) expect(shown).toContain(term.toLowerCase());
  });

  it('gives the OBS steps and quotes the real messages', () => {
    const wrapper = mount(HelpPage);
    const obs = wrapper.get('#stage-and-obs').text();
    expect(obs).toContain('Show audio');
    expect(obs).toContain('Control audio via OBS');
    expect(obs).toContain('Full scene (1920×1080)');
    expect(obs).toContain('Transparent overlay');
    expect(wrapper.get('#troubleshooting').text()).toContain('Refresh cache of current page');
    const trouble = wrapper.get('#troubleshooting').text();
    for (const message of [
      'Sign in or redeem an invitation first.',
      'This invitation is expired, already redeemed, or invalid.',
      'The story continues shortly',
      'This producer link is expired, revoked, or invalid. Ask the host for a new link.',
    ]) expect(trouble).toContain(message);
  });

  it('quotes the real card and seat labels', () => {
    const wrapper = mount(HelpPage);
    const characters = wrapper.get('#scenarios-and-characters').text();
    for (const label of [
      'Player writes their own', 'Describe a character', 'Use a saved card', 'Create show', 'Writing this card…', 'Let the player write it',
      'Describe your character', 'Write my card', 'Only a name is needed.', 'More about your character', 'Undo',
      'The AI picked these pronouns. Change them if you like.', 'Submit to director', 'Waiting for this player\'s card',
      'Write this card for them', 'Write the card', 'Start without this seat', 'Remove this seat? Its invitation stops working.',
      'Remove seat', 'Keep seat', 'Read card', 'Test as link',
    ]) expect(characters).toContain(label);
    for (const gone of [
      'Create the whole card with AI', 'Keep what I\'ve already written', 'Use this character', 'Keep these pronouns', 'Submit card for approval',
      'Write your character', 'Keep these boundaries', 'lasts 12 hours', 'You approve every card', 'approve the card',
    ]) expect(characters).not.toContain(gone);
    expect(characters).toContain('stays signed in until the show ends');
  });

  it('describes Cast & lobby in Running a show', () => {
    const running = mount(HelpPage).get('#running-a-show').text();
    for (const label of [
      'Before the show starts', 'Cast & lobby', 'Card waiting to be used', 'Use this card', 'Change this card', 'Save this card', 'Ready to start', 'Seats with a card', 'Copy all invitations',
      'Copy overlay link', 'Copy full-scene link', 'Back to the show', 'Start show', 'Read card', 'Test as', 'Waiting for this player\'s card', 'Write this card for them', 'Write the card',
      'Start without this seat', 'Remove this seat? Its invitation stops working.', 'What the AI won\'t write', 'Save boundaries',
    ]) expect(running).toContain(label);
    for (const gone of ['Get your cast ready', 'Mark ready', 'Start session', 'Approve every card', 'Content boundaries', 'Enter the scene', 'Copy show link']) expect(running).not.toContain(gone);
    expect(running).toContain('Players never see them, never accept them');
  });

  it('describes the director page flow with the shipped labels', () => {
    const wrapper = mount(HelpPage);
    const running = wrapper.get('#running-a-show').text();
    for (const label of [
      'Answer these lines', 'Open action round', 'Plan', 'What\'s at risk', 'Edit', 'Approve and roll', 'Step 1 of 3', 'Step 1 of 5',
      'More', 'Open conversation', 'Approve stakes', 'Roll the dice', 'Plan again', 'Regenerate script', 'Tell the AI what to change', 'Save edits',
      'Abandon this beat', 'Abandon beat', 'Preparing voice…', 'Voice ready', 'Publish without voice', 'Preview narration', 'Stop preview', 'Prepare voice again',
      'No show audio: the main show link isn\'t open in OBS.', 'Facts to remember', 'Don\'t keep these', 'Try again', 'Write it myself', 'Add a line',
      'Pause show', 'Resume show', 'End show', 'Keep going', 'End the show? Players will see that it\'s over, and it can\'t be restarted.',
      'Gallery link', 'Copy link', 'More gallery options', 'Show tools', 'Show all', 'Audio options', 'Note for the AI', 'Note for this beat', 'Save note', 'Clear note',
    ]) expect(running).toContain(label);
    for (const gone of [
      'Plan selected input', 'Lock input', 'Publish text-only beat', 'Publish with narration', 'Pause table', 'Resume table', 'Enter the scene',
      'Private AI direction', 'Private direction', 'Approve continuity updates', 'Save script edits', 'Prepare draft narration', 'Plan and draft',
    ]) expect(running).not.toContain(gone);
    expect(running).not.toContain('\u2014');
    expect(running).toContain('rolls the dice once');
    const text = wrapper.text();
    for (const gone of ['Pause table', 'Private AI direction', 'Approve continuity updates', 'Publish text-only beat']) expect(text).not.toContain(gone);
  });

  it('says every line rolls and a double 1 is a critical failure', () => {
    const wrapper = mount(HelpPage);
    const running = wrapper.get('#running-a-show').text();
    for (const phrase of [
      'Every line rolls, in conversations and in action rounds alike', 'Critical failure', 'Lock and draft appears only when you set a round to Ordinary conversation',
      'Only action rounds tick countdowns', 'conversation round rolls its dice without ticking them', 'at most six rolls', 'No check', 'Blocked',
    ]) expect(running).toContain(phrase);
    const players = wrapper.get('#players').text();
    expect(players).toContain('Every line you send can be rolled');
    expect(players).toContain('A double 1 is a critical failure');
    expect(glossary.map(item => item.term)).toContain('Critical failure');
  });

  it('names the glossary entries for the new director labels', () => {
    const terms = glossary.map(item => item.term);
    for (const term of ['Beat', 'What\'s at risk', 'Facts to remember', 'Note for the AI']) expect(terms).toContain(term);
    for (const gone of ['Stakes', 'Continuity', 'Private AI direction']) expect(terms).not.toContain(gone);
  });

  it('says the editor is quieter and boundaries never block Save', () => {
    const characters = mount(HelpPage).get('#scenarios-and-characters').text();
    for (const label of [
      'Fine-tune', 'More about this character', 'Advanced tools', 'Added by the AI. Edit freely.', 'What the AI won\'t write',
      'Nothing blocks Save scenario version',
    ]) expect(characters).toContain(label);
  });

  it('walks through Make a show with the real labels', () => {
    const started = mount(HelpPage).get('#getting-started').text();
    for (const label of [
      'What\'s the story?', 'Write my story', 'More options', 'Use this story', 'Use a saved story', 'Show title', 'Add a seat', 'Remove',
      'Player writes their own', 'Describe a character', 'Use a saved card', 'Create show', 'Try again', 'Let the player write it',
    ]) expect(started).toContain(label);
  });

  it('says the main show link exists from creation and sign-ins renew', () => {
    const wrapper = mount(HelpPage);
    const obs = wrapper.get('#stage-and-obs').text();
    expect(obs).toContain('Every new show already has one, made with the show');
    expect(obs).toContain('Make the main show link appears only when a show has none');
    const producers = wrapper.get('#producers').text();
    expect(producers).toContain('renews while it is used');
    expect(producers).toContain('whole browser');
    expect(producers).not.toContain('When the 12 hours end');
  });

  it('describes the quieter portraits with no approval', () => {
    const wrapper = mount(HelpPage);
    const pictures = wrapper.get('#pictures-and-portraits').text();
    for (const label of [
      'Create portrait appears below the description', 'There is no approval step', 'Creating the show never waits for the portraits',
      'Portraits finished. Save again to keep them in the library.', 'Save scenario version is never greyed out', 'Gallery link',
      'Your shows',
    ]) expect(pictures).toContain(label);
    for (const gone of [
      'Private link', 'Resume a saved session', 'Submit card for approval', 'Write your character',
      'Portraits are still being made. Save when they finish.', 'until the director approves the card',
    ]) expect(pictures).not.toContain(gone);
    expect(wrapper.text()).not.toContain('Resume a saved session');
  });

  it('keeps boundaries and cards free of approval and consent language in the glossary', () => {
    const boundaries = glossary.find(item => item.term === 'Boundaries')!.definition;
    expect(boundaries).toContain('Players never see them and never accept them');
    expect(boundaries).not.toContain('Players accept them');
    const card = glossary.find(item => item.term === 'Character card')!.definition;
    expect(card).not.toContain('approves every card');
  });

  it('walks a player from the invitation to the seat with the new labels', () => {
    const players = mount(HelpPage).get('#players').text();
    for (const label of [
      'You\'ve been invited to play',
      'Press Join to take your seat.',
      'Join',
      'This invitation has already been used or has expired. Ask your host for a new link.',
      'Your character',
      'Your host picked this character for you.',
      'Change my card',
      'Your host just saved a card for this seat.',
      "Use the host's card",
      'Keep mine',
      'Save my card',
      'The show will start soon.',
      'Seat 2 · waiting',
      'Character name',
      'Describe your character',
      'Write my card',
      'Only a name is needed.',
      'More about your character',
      'The AI picked these pronouns. Change them if you like.',
      'Give your character a name. Nothing has been saved.',
      'Undo',
      'How this works',
      'Talking to',
      'Change',
      'Sound',
      'Take it back',
    ]) expect(players).toContain(label);
    const steps = mount(HelpPage).get('#players').findAll('ol')[0].findAll('li').map(item => item.text());
    const at = (text: string) => steps.findIndex(step => step.includes(text));
    expect(at('Press Join')).toBeGreaterThan(-1);
    expect(at('Press Join')).toBeLessThan(at('Your character'));
    expect(at('Your character')).toBeLessThan(at('The show will start soon.'));
  });

  it('gives players no readiness, boundary acceptance or approval step', () => {
    const players = mount(HelpPage).get('#players').text();
    for (const gone of [
      'Mark ready', 'Write your character', 'Submit card for approval', 'Create the whole card with AI', 'Keep these pronouns',
      'Use this character', 'I reviewed my approved card', 'Finish setup', 'accepted in Cast & lobby', 'Join session',
      'Take it back again to confirm', 'Keep it if you change your mind', '12 hours',
    ]) expect(players).not.toContain(gone);
    expect(players).toContain('stays signed in until the show ends');
    expect(players).toContain('You never mark yourself ready, and you never accept any rules.');
  });

  it('describes the host home and the cast strip in Getting started', () => {
    const started = mount(HelpPage).get('#getting-started').text();
    for (const label of [
      'Try it now', 'Make a show', 'Your shows', 'The Ledger Job', 'Library & custom shows', 'More', 'Write my story', 'Use this story',
      'Use a saved story', 'Show title', 'Create show', 'Ready to start', 'Copy all invitations', 'Copy overlay link', 'Copy full-scene link', 'Card waiting to be used', 'Use this card', 'Open the director page', 'Start show',
      'Read card', 'Write this card for them', 'Start without this seat', 'What the AI won\'t write',
    ]) expect(started).toContain(label);
    for (const gone of ['Create rehearsal session', 'Mark ready', 'for 12 hours. When the 12 hours end']) expect(started).not.toContain(gone);
    expect(started).toContain('stays signed in until the show ends');
    expect(started).toContain('renews while you use it');
    expect(started).toContain('whole browser');
  });

  it('explains the sign-in lifetimes and the invitation message in Troubleshooting', () => {
    const trouble = mount(HelpPage).get('#troubleshooting').text();
    expect(trouble).toContain('This invitation has already been used or has expired. Ask your host for a new link.');
    expect(trouble).toContain('whole browser');
    expect(trouble).toContain('ends after about 12 hours without use');
    expect(trouble).not.toContain('Sign-ins last 12 hours');
    const heading = mount(HelpPage).findAll('#troubleshooting h3').map(node => node.text()).find(text => text === 'A player cannot send');
    expect(heading).toBe('A player cannot send');
    for (const gone of ['Mark ready', 'Finish setup first', 'tick the box']) expect(trouble).not.toContain(gone);
    expect(trouble).toContain('Start show');
    expect(trouble).toContain('Save my card');
  });

  it('explains the whole scenario draft with the real labels and messages', () => {
    const wrapper = mount(HelpPage);
    const characters = wrapper.get('#scenarios-and-characters').text();
    for (const text of [
      'Create the whole scenario with AI',
      'Describe your story',
      'Size',
      'Load into the editor',
      'Replace the editor with this draft',
      'Save scenario version',
      'Added by the AI. Edit freely.',
      'up to 3 minutes',
      'up to 4 minutes',
      'up to 6 minutes',
      'AI drafting is not available right now. You can still fill in the form yourself.',
      'The AI took too long. Try again, or fill in the form yourself.',
      'The AI\'s draft did not fit the form. Try again, or fill in the form yourself.',
      'A scenario draft is still being written. Wait for it to finish.',
    ]) expect(characters).toContain(text);
    expect(wrapper.get('#troubleshooting').text()).toContain('A scenario draft fails or takes too long');
    expect(characters).toContain('Wait a few minutes, then press Try again.');
    expect(wrapper.get('#troubleshooting').text()).toContain('Wait a few minutes, then press Try again.');
    expect(wrapper.get('#troubleshooting').text()).toContain('stays on the server for 15 minutes');
  });

  it('keeps section headings unique within each topic', () => {
    for (const topic of topics) {
      const headings = topic.sections.map(section => section.heading);
      expect(new Set(headings).size).toBe(headings.length);
    }
  });

  it('lists contents links that match the rendered sections in order', () => {
    const wrapper = mount(HelpPage);
    const linked = wrapper.findAll('nav a').map(link => link.attributes('href')?.split('#')[1]);
    const rendered = wrapper.findAll('.help-page > section[id]').map(section => section.attributes('id'));
    expect(linked).toEqual(rendered);
    expect(linked).toEqual(anchors);
    expect(topics.map(topic => topic.id)).toEqual(anchors.filter(id => id !== 'glossary'));
  });

  it('uses a main landmark as the page root', () => {
    const wrapper = mount(HelpPage);
    expect(wrapper.element.tagName).toBe('MAIN');
    expect(wrapper.classes()).toContain('help-page');
  });

  it('builds contents links from the help path and keeps the tab identity', () => {
    const plain = mount(HelpPage);
    expect(plain.findAll('nav a').map(link => link.attributes('href'))).toEqual(anchors.map(id => `/help#${id}`));
    const identity = 'b'.repeat(32);
    window.history.replaceState({}, '', `/help?identity=${identity}`);
    const wrapper = mount(HelpPage);
    expect(wrapper.findAll('nav a').map(link => link.attributes('href'))).toEqual(anchors.map(id => `/help?identity=${identity}#${id}`));
  });

  it('links Back to the host home and keeps the tab identity', () => {
    expect(mount(HelpPage).get('[data-testid="help-back"]').text()).toBe('Back');
    expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href')).toBe('/');
    const identity = 'c'.repeat(32);
    window.history.replaceState({}, '', `/help?identity=${identity}`);
    expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href')).toBe(`/?identity=${identity}`);
  });

  it('links Back to the stored in-app address, even after a Contents hash change', () => {
    const identity = 'd'.repeat(32);
    const stored = `/sessions/abc/play?identity=${identity}`;
    window.sessionStorage.setItem('story-table-return-path', stored);
    window.history.replaceState({}, '', `/help?identity=${identity}`);
    const wrapper = mount(HelpPage);
    expect(wrapper.get('[data-testid="help-back"]').attributes('href')).toBe(stored);
    window.location.hash = '#producers';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(wrapper.get('[data-testid="help-back"]').attributes('href')).toBe(stored);
  });

  it('uses the stored address when there is no identity on either side', () => {
    window.sessionStorage.setItem('story-table-return-path', '/sessions/abc/director#stage-links');
    window.history.replaceState({}, '', '/help');
    expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href')).toBe('/sessions/abc/director#stage-links');
  });

  it('falls back to the home page for an unusable stored address', () => {
    const identity = 'e'.repeat(32);
    window.history.replaceState({}, '', `/help?identity=${identity}`);
    const fallback = `/?identity=${identity}`;
    for (const value of ['//evil.example', 'https://x', '/help#a', '/help', '/help/x', `/sessions/abc/play?identity=${'f'.repeat(32)}`, '/sessions/abc/play']) {
      window.sessionStorage.setItem('story-table-return-path', value);
      expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href'), value).toBe(fallback);
    }
  });

  it('falls back to the home page for an off-site stored address when neither side carries an identity', () => {
    window.history.replaceState({}, '', '/help');
    for (const value of ['//evil.example', 'https://x']) {
      window.sessionStorage.setItem('story-table-return-path', value);
      expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href'), value).toBe('/');
    }
  });

  it('falls back to the home page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(mount(HelpPage).get('[data-testid="help-back"]').attributes('href')).toBe('/');
  });

  it('renders topic headings, steps and the glossary list', () => {
    const wrapper = mount(HelpPage);
    const running = wrapper.get('#running-a-show');
    expect(running.get('h2').text()).toBe('Running a show');
    expect(running.findAll('h3').length).toBeGreaterThan(0);
    expect(running.findAll('ol li').length).toBeGreaterThan(0);
    expect(wrapper.get('section#glossary dl').findAll('dt')).toHaveLength(glossary.length);
  });

  it('places the glossary directly before troubleshooting when that topic exists', () => {
    const wrapper = mount(HelpPage);
    const ids = wrapper.findAll('.help-page > section[id]').map(section => section.attributes('id'));
    const at = ids.indexOf('troubleshooting');
    expect(at).toBeGreaterThan(0);
    expect(ids[at - 1]).toBe('glossary');
  });

  it('imports no api module', () => {
    expect(read('./HelpPage.vue')).not.toMatch(/from\s+['"]\.\/(api|table)['"]/);
  });

  it('keeps the age and gender advice as the second paragraph for non-player character portraits', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const section = topic.sections.find(item => item.heading === 'Portraits for non-player characters')!;
    expect(section.paragraphs?.[1]).toBe('A portrait is drawn only from a character\'s Appearance and Role. Start Appearance with age and gender, for example "A woman in her forties with a folded apron", so the portrait matches.');
  });

  it('tells directors where to get a picture style suggestion', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const section = topic.sections.find(item => item.heading === 'The picture style')!;
    expect(section.paragraphs?.some(text => text.includes('Press AI Generate beside it, then Generate, for a suggestion'))).toBe(true);
  });

  it('explains sharing the pictures with chat', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const section = topic.sections.find(item => item.heading === 'Sharing the pictures with chat')!;
    const text = section.paragraphs?.join(' ') ?? '';
    expect(text).toContain('Turn on gallery');
    expect(text).toContain('Turn off gallery');
  });

  it('says pictures have no count limit and keeps the old caps out of the Limits section', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const section = topic.sections.find(item => item.heading === 'Limits')!;
    expect(section.paragraphs).toContain('There is no limit on how many pictures a show, a scene or a character can have.');
    expect(section.paragraphs?.join(' ')).not.toMatch(/\b(120|200|10)\b/);
  });

  it('keeps the newest-moment rule and the action round sentence in the pictures help', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const text = topic.sections.flatMap(item => item.paragraphs ?? []).join(' ');
    expect(text).toContain('Each action round gets its own picture too, as long as its script has narration.');
    expect(text).toContain('The stream always shows the newest moment, so when you publish a round that has its own picture, a Draw the place picture still being made is dropped, because the round is newer.');
    expect(text).toContain('The picture service would not draw this round. You can still publish it.');
  });

  it('explains the picture buttons, start-over, the settings fold-out, timing and the model choice', () => {
    const topic = topics.find(item => item.id === 'pictures-and-portraits')!;
    const text = topic.sections.flatMap(item => item.paragraphs ?? []).join(' ');
    expect(text).not.toContain('New picture');
    expect(text).not.toMatch(/greyed out while a picture/);
    expect(text).toContain('Draw the last beat is greyed out until a beat has been published in this scene.');
    expect(text).toContain('Pressing either button while a picture is on its way starts over.');
    expect(text).toContain('A round\'s picture waiting for you to publish is never touched by this.');
    expect(text).toContain('A change applies to pictures started after you save.');
    expect(text).toContain('using the first 10 portraits');
    expect(text).toContain('because the story AI writes the description first. Expect anywhere from 25 seconds to 2 minutes.');
    expect(text).toContain('The show never waits for a picture.');
    expect(topic.sections.some(item => item.heading === 'Picture settings')).toBe(true);
  });

  it('puts Streaming from your own OBS right after Stage and OBS for players and streamers', () => {
    const ids = topics.map(topic => topic.id);
    expect(ids.indexOf('streaming-your-own-obs')).toBe(ids.indexOf('stage-and-obs') + 1);
    const topic = topics.find(item => item.id === 'streaming-your-own-obs')!;
    expect(topic.title).toBe('Streaming from your own OBS');
    expect(topic.audience).toEqual(['player', 'streamer']);
    expect(topics.find(item => item.id === 'stage-and-obs')!.audience).toContain('streamer');
    expect(topics.find(item => item.id === 'troubleshooting')!.audience).toContain('streamer');
    const text = mount(HelpPage).get('#streaming-your-own-obs').text();
    for (const label of ['Stream this show', 'Copy overlay link', 'Copy full-scene link', 'How to add this in OBS', 'Preview (silent)', 'Sound options']) expect(text).toContain(label);
    expect(text).not.toContain('Press Make a new link');
    expect(text).toContain('makes a fresh link by itself');
  });

  describe('roles', () => {
    const topicIds = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.help-page > section[id]').map(section => section.attributes('id'));

    it('shows every topic and no first steps when no role is chosen', () => {
      const wrapper = mount(HelpPage);
      expect(topicIds(wrapper)).toEqual(anchors);
      expect(wrapper.find('[data-testid="help-first-steps"]').exists()).toBe(false);
      for (const role of ['host', 'player', 'streamer']) expect(wrapper.get(`[data-testid="help-role-${role}"]`).attributes('aria-pressed')).toBe('false');
      expect(wrapper.get('[data-testid="help-role-host"]').text()).toBe('I\'m the host');
      expect(wrapper.get('[data-testid="help-role-player"]').text()).toBe('I\'m a player');
      expect(wrapper.get('[data-testid="help-role-streamer"]').text()).toBe('I\'m streaming');
    });

    it('filters topics by audience, filters the contents list and lists the steps', async () => {
      const wrapper = mount(HelpPage);
      await wrapper.get('[data-testid="help-role-streamer"]').trigger('click');
      expect(wrapper.get('[data-testid="help-role-streamer"]').attributes('aria-pressed')).toBe('true');
      const expected = topics.filter(topic => topic.audience.includes('streamer')).map(topic => topic.id);
      expect(topicIds(wrapper)).toEqual(['stage-and-obs', 'streaming-your-own-obs', 'glossary', 'troubleshooting']);
      expect(expected).toEqual(['stage-and-obs', 'streaming-your-own-obs', 'troubleshooting']);
      expect(wrapper.findAll('nav a').map(link => link.attributes('href')?.split('#')[1])).toEqual(topicIds(wrapper));
      const steps = wrapper.get('[data-testid="help-first-steps"]');
      expect(steps.get('h2').text()).toBe('Do this first');
      expect(steps.findAll('li').map(item => item.text())).toEqual(firstSteps.streamer);

      await wrapper.get('[data-testid="help-role-player"]').trigger('click');
      expect(wrapper.get('[data-testid="help-role-streamer"]').attributes('aria-pressed')).toBe('false');
      expect(topicIds(wrapper)).toContain('players');
      expect(topicIds(wrapper)).not.toContain('producers');
      expect(wrapper.findAll('[data-testid="help-first-steps"] li').map(item => item.text())).toEqual(firstSteps.player);

      await wrapper.get('[data-testid="help-role-host"]').trigger('click');
      expect(topicIds(wrapper)).toContain('running-a-show');
      expect(wrapper.findAll('[data-testid="help-first-steps"] li').map(item => item.text())).toEqual(firstSteps.host);
    });

    it('clears the role when the chosen button is pressed again', async () => {
      const wrapper = mount(HelpPage);
      await wrapper.get('[data-testid="help-role-host"]').trigger('click');
      await wrapper.get('[data-testid="help-role-host"]').trigger('click');
      expect(wrapper.get('[data-testid="help-role-host"]').attributes('aria-pressed')).toBe('false');
      expect(topicIds(wrapper)).toEqual(anchors);
      expect(wrapper.find('[data-testid="help-first-steps"]').exists()).toBe(false);
      expect(window.localStorage.getItem('story-table-help-role')).toBeNull();
    });

    it('keeps the choice in localStorage and restores it', async () => {
      const first = mount(HelpPage);
      await first.get('[data-testid="help-role-player"]').trigger('click');
      expect(window.localStorage.getItem('story-table-help-role')).toBe('player');
      const second = mount(HelpPage);
      expect(second.get('[data-testid="help-role-player"]').attributes('aria-pressed')).toBe('true');
      expect(second.findAll('[data-testid="help-first-steps"] li')).toHaveLength(firstSteps.player.length);
    });

    it('ignores a stored value that is not a role', () => {
      window.localStorage.setItem('story-table-help-role', 'wizard');
      const wrapper = mount(HelpPage);
      expect(topicIds(wrapper)).toEqual(anchors);
    });

    it('still works when localStorage throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
      const wrapper = mount(HelpPage);
      expect(topicIds(wrapper)).toEqual(anchors);
      await wrapper.get('[data-testid="help-role-host"]').trigger('click');
      expect(wrapper.get('[data-testid="help-role-host"]').attributes('aria-pressed')).toBe('true');
      await wrapper.get('[data-testid="help-role-host"]').trigger('click');
      expect(wrapper.get('[data-testid="help-role-host"]').attributes('aria-pressed')).toBe('false');
    });

    it('gives each role three to five first steps', () => {
      for (const steps of Object.values(firstSteps)) {
        expect(steps.length).toBeGreaterThanOrEqual(3);
        expect(steps.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('folding', () => {
    it('folds topics over 250 words under their title and leaves short ones open', () => {
      const wrapper = mount(HelpPage);
      const longIds = topics.filter(topic => countWords(topic) > 250).map(topic => topic.id);
      const shortIds = topics.filter(topic => countWords(topic) <= 250).map(topic => topic.id);
      expect(longIds.length).toBeGreaterThan(0);
      for (const id of longIds) {
        const details = wrapper.get(`section#${id} > details`);
        expect(details.attributes('open')).toBeUndefined();
        expect(details.get('summary').text()).toBe(topics.find(topic => topic.id === id)!.title);
      }
      for (const id of shortIds) expect(wrapper.find(`section#${id} details`).exists()).toBe(false);
    });

    it('opens a folded topic when the hash names it and scrolls it into view', async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      window.history.replaceState({}, '', '/help#running-a-show');
      const wrapper = mount(HelpPage, { attachTo: document.body });
      await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(wrapper.get('section#running-a-show > details').attributes('open')).toBeDefined();
      expect(scroll.mock.contexts[0]).toBe(document.getElementById('running-a-show'));
      wrapper.unmount();
    });

    it('opens and shows the named topic on hashchange, even when the role hides it', async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      window.localStorage.setItem('story-table-help-role', 'streamer');
      const wrapper = mount(HelpPage, { attachTo: document.body });
      expect(wrapper.find('section#producers').exists()).toBe(false);
      window.history.replaceState({}, '', '/help#producers');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await vi.waitFor(() => expect(wrapper.find('section#producers').exists()).toBe(true));
      await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
      const folded = countWords(topics.find(topic => topic.id === 'producers')!) > 250;
      if (folded) expect(wrapper.get('section#producers > details').attributes('open')).toBeDefined();
      expect(wrapper.findAll('nav a').some(link => link.attributes('href')?.endsWith('#producers'))).toBe(true);
      wrapper.unmount();
    });

    it('ignores a hash that names no topic', async () => {
      window.history.replaceState({}, '', '/help#nothing-here');
      const wrapper = mount(HelpPage, { attachTo: document.body });
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.help-page > section[id]')).toHaveLength(anchors.length);
      wrapper.unmount();
    });
  });

  it('keeps em dashes out of the help copy', () => {
    expect(read('./help/content.ts')).not.toContain('—');
    expect(read('./help/content.ts')).not.toContain(' -- ');
  });

  it('describes the stream and producer flow with the shipped labels', () => {
    const wrapper = mount(HelpPage);
    const obs = wrapper.get('#stage-and-obs').text();
    for (const label of [
      'Stream this show', 'For your stream', 'For a cast member\'s own stream', 'For your own stream', 'Copy overlay link', 'Copy full-scene link',
      'Sound options', 'If this computer also plays the story, turn this link\'s sound off or you\'ll hear it twice.',
      'How to add this in OBS', 'Preview (silent)', 'Turn off', 'Keep link', 'Preview (not for OBS)', 'Preview only, not for OBS. For OBS, use a link from Stream this show.',
      'Back to the director page', 'Audio options', 'Present audio', 'Make a new link',
    ]) expect(obs).toContain(label);
    for (const step of [
      'In OBS, open Sources, press +, and choose Browser.', 'Paste the link into URL.', 'Set Width to 1920 and Height to 1080.',
      'Untick Shutdown source when not visible and Refresh browser when scene becomes active.', 'Tick Control audio via OBS.',
    ]) expect(obs).toContain(step);
    const producers = wrapper.get('#producers').text();
    for (const label of ['Create producer link', 'Copied. Send it privately. It signs them in.', 'Turn off', 'Keep access', 'Shows you can run', 'Open the director page']) expect(producers).toContain(label);
    const players = wrapper.get('#players').text();
    expect(players).toContain('Stream this show');
    expect(players).toContain('Your own stream link');
    for (const gone of ['Create my stream link', 'Turn off link', 'Show my stream view', 'My stream view']) expect(players).not.toContain(gone);
    const everything = [obs, producers, players, wrapper.get('#troubleshooting').text(), wrapper.get('#getting-started').text()].join(' ');
    for (const gone of ['Copy show link', 'Open preview', 'Stage & OBS links', 'Show stage & OBS links', 'Stage audio:', 'Create main show link', 'Broadcast audio', 'Revoke access']) expect(everything).not.toContain(gone);
  });
});
