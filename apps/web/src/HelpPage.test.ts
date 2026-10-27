// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import HelpPage from './HelpPage.vue';
import { glossary, topics } from './help/content';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

afterEach(() => window.history.replaceState({}, '', '/'));

describe('help page', () => {
  const anchors = ['getting-started', 'running-a-show', 'scenarios-and-characters', 'producers', 'players', 'stage-and-obs', 'pictures-and-portraits', 'glossary', 'troubleshooting'];
  const terms = [
    'beat', 'conversation', 'action round', 'stakes', 'contract', 'ruling', 'trait', 'risk', 'Edge', 'outcome bands', 'strain', 'track',
    'continuity', 'input window', 'presenter', 'Listen', 'text-only beat', 'test seat', 'host', 'director', 'producer', 'boundaries',
    'stage', 'scene layout', 'overlay layout', 'stream link', 'character card', 'character link',
  ];

  it('renders each of the nine anchors once, in order', () => {
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
    expect(obs).toContain('Broadcast audio');
    expect(obs).toContain('Control audio via OBS');
    expect(obs).toContain('Full scene (1920×1080)');
    expect(obs).toContain('Transparent overlay');
    expect(obs).toContain('Refresh cache of current page');
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
      'Player writes their own character',
      'Create the whole card with AI',
      'Describe your character',
      'Keep what I\'ve already written',
      'Use this character',
      'Undo',
      'Keep these pronouns',
      'Submit to director',
      'Waiting for this player\'s card',
      'Test as link',
      'Submit card for approval',
    ]) expect(characters).toContain(label);
    const players = wrapper.get('#players').text();
    expect(players).toContain('Write your character');
    expect(players).toContain('Submit card for approval');
    const steps = wrapper.get('#players').findAll('ol')[0].findAll('li').map(item => item.text());
    expect(steps.findIndex(step => step.includes('Write your character'))).toBeLessThan(steps.findIndex(step => step.includes('Mark ready')));
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
      'Keep these boundaries',
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

  it('links back to the host home and keeps the tab identity', () => {
    expect(mount(HelpPage).get('a[href="/"]').text()).toBe('Back to host home');
    const identity = 'c'.repeat(32);
    window.history.replaceState({}, '', `/help?identity=${identity}`);
    const link = mount(HelpPage).findAll('a').find(item => item.text() === 'Back to host home');
    expect(link?.attributes('href')).toBe(`/?identity=${identity}`);
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

  it('keeps em dashes out of the help copy', () => {
    expect(read('./help/content.ts')).not.toContain('—');
    expect(read('./help/content.ts')).not.toContain(' -- ');
  });
});
