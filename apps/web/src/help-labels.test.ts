import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const normalize = (text: string) => text.replaceAll("\\'", "'");
const help = normalize(readFileSync(fileURLToPath(new URL('./help/content.ts', import.meta.url)), 'utf8'));
const screens = readdirSync(dir)
  .filter(name => name.endsWith('.vue'))
  .map(name => normalize(readFileSync(`${dir}${name}`, 'utf8')))
  .join('\n');

const labels = [
  'Player writes their own character',
  'Create the whole card with AI',
  'Describe your character',
  "Keep what I've already written",
  'Use this character',
  'Keep these pronouns',
  'Submit to director',
  "Waiting for this player's card",
  'Test as link',
  'Write your character',
  'Submit card for approval',
  'Mark ready',
  'Cast & lobby',
  'Library & custom shows',
  'Create the whole scenario with AI',
  'Describe your story',
  'Load into the editor',
  'Replace the editor with this draft',
  'Save scenario version',
  'Keep these boundaries',
  'Check before you save',
  'What the app changed',
  'Create portrait',
  'Use this portrait',
  'Remove portrait',
  'Draw the place',
  'Draw the last beat',
  'Hide picture',
  'Show picture',
  'Create portraits for everyone',
  'Picture style',
  'Making the picture...',
  'It stays hidden until you press Show picture.',
  'Pictures are off on this server.',
  'Draw the place makes a new picture of this scene\'s place. Draw the last beat draws the newest beat in this scene, with everyone who took part. Pressing either one while a picture is on its way starts over. The new picture takes the old one\'s place when it is ready.',
  'Drawing the last beat…',
  'No beat has been published in this scene yet.',
  'The picture could not be made. Press Draw the place to try again.',
  'Picture settings',
  'Art style',
  'Picture model',
  'Server default',
  'Save picture settings',
  'Pictures of a beat use FLUX 3 Klein when anyone in them has a portrait, because it is the only model that can draw your cast from their portraits.',
  'The model that draws place pictures, portraits, and pictures of a beat where nobody has a portrait, in shows made from this scenario. Server default uses the server\'s setting. When anyone in a beat has a portrait, FLUX 3 Klein draws the picture.',
  'Painterly',
  'Comic book ink',
  'Watercolor storybook',
  'Anime',
  'Dark fantasy oil painting',
  'Cinematic photo',
  'Pixel art',
  'Film noir',
  'Making the picture for this action round. Viewers and players see it when you publish the round.',
  'The picture for this action round is ready. Viewers and players see it when you publish the round.',
  'The picture for this action round could not be made. You can still publish the round, and the stream keeps the picture it has now.',
  'AI Generate',
  'Generate',
  'Unsaved changes',
  'Portraits are still being made. Save when they finish.',
];

describe('help labels', () => {
  it.each(labels)('quotes "%s" in the help and ships it on a screen', label => {
    expect(help).toContain(label);
    expect(screens).toContain(label);
  });
});
