import { describe, expect, it } from 'vitest';
import { failureMessage } from '../src/galleries';

const PREFIX = 'The gallery could not be written: ';
const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('failureMessage', () => {
  it('says the disk is full for ENOSPC', () => {
    expect(failureMessage(withCode('ENOSPC'))).toBe(`${PREFIX}the server's disk is full.`);
  });
  it.each(['EACCES', 'EPERM', 'EROFS'])('says the server is not allowed to write for %s', code => {
    expect(failureMessage(withCode(code))).toBe(`${PREFIX}the server isn't allowed to write to its picture folder.`);
  });
  it('names the code for any other code', () => {
    expect(failureMessage(withCode('EMFILE'))).toBe(`${PREFIX}something went wrong on the server (EMFILE).`);
  });
  it('gives the plain wording when the error has no code', () => {
    expect(failureMessage(new Error('boom'))).toBe(`${PREFIX}something went wrong on the server.`);
    expect(failureMessage('just a string')).toBe(`${PREFIX}something went wrong on the server.`);
    expect(failureMessage(null)).toBe(`${PREFIX}something went wrong on the server.`);
    expect(failureMessage(undefined)).toBe(`${PREFIX}something went wrong on the server.`);
  });
  it('never repeats a path or other text from error.message', () => {
    const path = '/home/khuff/code/fun/twitch-ai-rpg/.local/audio/galleries/secret-slug/index.html';
    for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', undefined]) {
      const error = code ? withCode(code, `${code}: no space left on device, open '${path}'`) : new Error(`failed at ${path}`);
      const message = failureMessage(error);
      expect(message).not.toContain(path);
      expect(message).not.toContain('secret-slug');
      expect(message).not.toContain('no space left');
    }
  });
  it('stays within 300 characters even with a very long code', () => {
    const message = failureMessage(withCode('E'.repeat(500)));
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.startsWith(PREFIX)).toBe(true);
  });
});
