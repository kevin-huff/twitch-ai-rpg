import { describe, expect, it } from 'vitest';
import {
  CharacterSchema, CommandSchema, DELIVERY_TAGS, FAKE_VOICES, VoiceListSchema, elevenVoiceId, fakeVoiceSource,
  hasAudioTags, spokenText, stripAudioTags, voiceTextMatches, voicedWords,
} from './index';

const storedCharacter = {
  id: 'c1', displayName: 'Mara', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0,
};

describe('voice references', () => {
  it('accepts eleven references and rejects everything else', () => {
    expect(elevenVoiceId('eleven:abc_D-1')).toBe('abc_D-1');
    expect(elevenVoiceId('narrator')).toBeNull();
    expect(elevenVoiceId('eleven:')).toBeNull();
    expect(elevenVoiceId('eleven:a b')).toBeNull();
    expect(elevenVoiceId(null)).toBeNull();
    expect(elevenVoiceId(undefined)).toBeNull();
  });

  it('serves fake voices that match the list schema', async () => {
    const list = await fakeVoiceSource.listVoices();
    expect(VoiceListSchema.parse(list).voices.map((voice) => voice.name)).toEqual(['Ada', 'Bram', 'Cyd']);
    expect(list.voices).toEqual(FAKE_VOICES);
    expect(list.voices).not.toBe(FAKE_VOICES);
  });
});

describe('audio tags', () => {
  it('strips tags and tidies spacing', () => {
    expect(hasAudioTags('[laughs] Fine')).toBe(true);
    expect(hasAudioTags('Fine, I will.')).toBe(false);
    expect(stripAudioTags('[laughs] Fine,  I will [pause] do it.')).toBe('Fine, I will do it.');
    expect(stripAudioTags('[sighs] First line.\n[whispers] Second line.')).toBe('First line.\nSecond line.');
  });

  it('checks that a voice copy only adds tags', () => {
    expect(voiceTextMatches('Fine, I will do it.', '[laughs] Fine, I will [pause] do it.')).toBe(true);
    expect(voiceTextMatches('Fine, I will do it.', 'Fine,   I will\ndo it.')).toBe(true);
    expect(voiceTextMatches('Fine, I will do it.', '[laughs] Fine, I won\'t do it.')).toBe(false);
    expect(voiceTextMatches('Wait.', 'Wait. <break time="1s"/>')).toBe(false);
    expect(voiceTextMatches('Wait\u2014you think he ran?', '[shocked] Wait\u2014[incredulous] you think he ran?')).toBe(true);
    expect(voiceTextMatches('Wait\u2014you think he ran?', 'Wait\u2014[incredulous]you think he ran?')).toBe(true);
    expect(voiceTextMatches('Mara leans in. "Run."', 'Mara leans in. "[whispers] Run."')).toBe(true);
    expect(voiceTextMatches('I...I saw nothing.', 'I...[gulps] I saw nothing.')).toBe(true);
    expect(voiceTextMatches('Fine, I will do it.', '[a][b] Fine, I will [c] [d] do it. [e]')).toBe(true);
    expect(voiceTextMatches('Wait\u2014you think he ran?', 'Wait\u2014[incredulous] you think he fled?')).toBe(false);
    expect(voiceTextMatches('I saw nothing.', 'I [gulps] really saw nothing.')).toBe(false);
    expect(voiceTextMatches('Wait.', '[a] Wait. And then.')).toBe(false);
    expect(voiceTextMatches('Hello there.', '[warmly] Hello there.\n')).toBe(true);
    expect(voiceTextMatches('Hello there.', 'Hello there. ')).toBe(true);
    expect(voiceTextMatches('Hello there.', '[warmly] Hello there. ')).toBe(true);
    expect(voiceTextMatches('Run.', 'Run. ')).toBe(true);
    expect(voiceTextMatches('Run.\n', ' Run.\n')).toBe(true);
    expect(voiceTextMatches('Run.', 'Run. [gasps]\n')).toBe(true);
  });

  it('builds the words a voice speaks', () => {
    const text = 'Hold the door.';
    expect(voicedWords({ text, voiceText: '[sighs] Hold the door.', delivery: 'urgent' })).toBe('[sighs] Hold the door.');
    expect(voicedWords({ text, delivery: 'quiet' })).toBe('[quietly] Hold the door.');
    expect(voicedWords({ text, delivery: 'urgent' })).toBe('[urgently] Hold the door.');
    expect(voicedWords({ text, delivery: 'amused' })).toBe('[amused] Hold the door.');
    expect(voicedWords({ text, delivery: 'neutral' })).toBe(text);
    expect(DELIVERY_TAGS.neutral).toBe('');
  });
});

describe('spokenText with voices', () => {
  it('drops the name for an own-voice Say line', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Hi.', voiceProfileId: 'eleven:fake-ada' })).toBe('Hi.');
  });

  it('keeps the name for narrator Say lines and for Do lines', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Hi.', voiceProfileId: 'voice_narrator' })).toBe('Dash: Hi.');
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Hi.', voiceProfileId: null })).toBe('Dash: Hi.');
    expect(spokenText({ kind: 'player_action', speaker: 'Dash', text: 'I run.', voiceProfileId: 'eleven:fake-ada' })).toBe('Dash: I run.');
  });

  it('prefers the voice copy over a delivery tag', () => {
    expect(spokenText({ kind: 'npc_dialogue', speaker: 'Ines', text: 'Run.', voiceText: '[gasps] Run.', delivery: 'urgent' })).toBe('[gasps] Run.');
    expect(spokenText({ kind: 'npc_dialogue', speaker: 'Ines', text: 'Run.', delivery: 'urgent' })).toBe('[urgently] Run.');
    expect(spokenText({ kind: 'narration', speaker: 'Narrator', text: 'Night falls.' })).toBe('Night falls.');
  });

  it('cleans angle-bracket words out of the speaker name', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash <the Bold>', text: 'Hi.' })).toBe('Dash: Hi.');
  });

  it('handles lines with no words or no name', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: '<grin>', voiceProfileId: 'eleven:fake-ada' })).toBe('Dash');
    expect(spokenText({ kind: 'player_action', speaker: '<x>', text: 'I run.' })).toBe('I run.');
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: '[laughs]', voiceText: '[laughs]' })).toBe('Dash: [laughs]');
  });
});

describe('voice fields', () => {
  it('reads an old character as using the narrator', () => {
    expect(CharacterSchema.parse(storedCharacter).voiceProfileId).toBeNull();
    expect(CharacterSchema.parse({ ...storedCharacter, voiceProfileId: 'eleven:fake-ada' }).voiceProfileId).toBe('eleven:fake-ada');
  });

  it('parses set_voice with a reference or null only', () => {
    expect(CommandSchema.parse({ type: 'set_voice', commandId: 'c1', voiceProfileId: 'eleven:fake-ada' })).toMatchObject({ voiceProfileId: 'eleven:fake-ada' });
    expect(CommandSchema.parse({ type: 'set_voice', commandId: 'c1', voiceProfileId: null })).toMatchObject({ voiceProfileId: null });
    expect(() => CommandSchema.parse({ type: 'set_voice', commandId: 'c1', voiceProfileId: 'voice_mara' })).toThrow();
  });
});
