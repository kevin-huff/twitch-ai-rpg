import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { imageTypeOf, MOMENT_PROMPT_MAX, PICTURE_NEGATIVE_PROMPT, PICTURE_PROMPT_MAX, type ImageRequest } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { FakeImageProvider, fakeImageBytes } from '../src/fake-images';
import { readImageFile, storeImage } from '../src/image-files';

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { prompt: 'A lantern-lit harbor', negativePrompt: PICTURE_NEGATIVE_PROMPT, width: 1344, height: 768, requestId: randomUUID(), title: 'Scene picture', ...overrides };
}

describe('fakeImageBytes', () => {
  it('depends only on the prompt', () => {
    const a = fakeImageBytes(request());
    expect(Buffer.from(fakeImageBytes(request()))).toEqual(Buffer.from(a));
    expect(Buffer.from(fakeImageBytes(request({ prompt: 'Another place' })))).not.toEqual(Buffer.from(a));
  });

  it('is a valid PNG with the right size, checksums and pixels', () => {
    const bytes = Buffer.from(fakeImageBytes(request()));
    expect(imageTypeOf(bytes)).toBe('image/png');
    let offset = 8;
    const types: string[] = [];
    let idat = Buffer.alloc(0);
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const body = bytes.subarray(offset + 4, offset + 8 + length);
      expect(bytes.readUInt32BE(offset + 8 + length)).toBe(crc32(body));
      const type = body.subarray(0, 4).toString('ascii');
      types.push(type);
      if (type === 'IHDR') {
        expect(body.readUInt32BE(4)).toBe(84);
        expect(body.readUInt32BE(8)).toBe(48);
        expect([...body.subarray(12, 17)]).toEqual([8, 2, 0, 0, 0]);
      }
      if (type === 'IDAT') idat = body.subarray(4);
      offset += 12 + length;
    }
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(inflateSync(idat).length).toBe(48 * (1 + 84 * 3));
  });

  it('sizes portraits 48 by 48 and keeps a floor of 8', () => {
    const portrait = Buffer.from(fakeImageBytes({ prompt: 'x', width: 768, height: 768 }));
    expect(portrait.readUInt32BE(16)).toBe(48);
    expect(portrait.readUInt32BE(20)).toBe(48);
    const tiny = Buffer.from(fakeImageBytes({ prompt: 'x', width: 64, height: 64 }));
    expect(tiny.readUInt32BE(16)).toBe(8);
  });
});

describe('FakeImageProvider', () => {
  it('records requests and returns a png', async () => {
    const provider = new FakeImageProvider();
    const input = request();
    const result = await provider.generate(input);
    expect(provider.requests).toEqual([input]);
    expect(result).toMatchObject({ contentType: 'image/png', width: 1344, height: 768, workflowId: `fake-${input.requestId}` });
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(fakeImageBytes(input)));
    expect(provider.name).toBe('fake');
    expect(provider.model).toBe('fake-image');
  });

  it('rejects invalid requests without recording them', async () => {
    const provider = new FakeImageProvider();
    for (const bad of [
      request({ prompt: '' }), request({ prompt: 'x'.repeat(PICTURE_PROMPT_MAX + 1) }), request({ prompt: 'bad\u0007prompt' }),
      request({ width: 1000 }), request({ height: 128 }), request({ width: 4096 }),
      request({ requestId: 'nope' }), request({ title: '' }), request({ title: 'x'.repeat(81) }),
    ]) {
      await expect(provider.generate(bad)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(provider.requests).toHaveLength(0);
  });

  it('records the model and references of a request', async () => {
    const provider = new FakeImageProvider();
    const reference = Object.freeze({ provider: 'fake' });
    const input = request({ model: 'flux-3-klein', references: [reference] });
    await provider.generate(input);
    expect(provider.requests[0]).toMatchObject({ model: 'flux-3-klein', references: [reference] });
  });

  it('accepts a prompt up to the limit for its kind of picture and refuses one past it', async () => {
    const provider = new FakeImageProvider();
    const references = [Object.freeze({ provider: 'fake' })];
    await expect(provider.generate(request({ prompt: 'x'.repeat(PICTURE_PROMPT_MAX) }))).resolves.toMatchObject({ contentType: 'image/png' });
    await expect(provider.generate(request({ prompt: 'x'.repeat(PICTURE_PROMPT_MAX + 1) }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(provider.generate(request({ prompt: 'x'.repeat(MOMENT_PROMPT_MAX), references }))).resolves.toMatchObject({ contentType: 'image/png' });
    await expect(provider.generate(request({ prompt: 'x'.repeat(MOMENT_PROMPT_MAX + 1), references }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(provider.requests).toHaveLength(2);
  });

  it('applies fail', async () => {
    const provider = new FakeImageProvider({ fail: () => new ProviderError('http_error', 'Sogni', 402) });
    await expect(provider.generate(request())).rejects.toMatchObject({ code: 'http_error', status: 402 });
  });

  it('waits for delayMs and hold', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const provider = new FakeImageProvider({ delayMs: 20, hold: () => hold });
    let done = false;
    const pending = provider.generate(request()).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done).toBe(false);
    release();
    await pending;
    expect(done).toBe(true);
  });

  it('rejects promptly on abort during the delay, the hold, or before starting', async () => {
    const controller = new AbortController();
    const delayed = new FakeImageProvider({ delayMs: 60_000 });
    const first = delayed.generate(request({ signal: controller.signal }));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'invalid_context' });

    const second = new AbortController();
    const held = new FakeImageProvider({ hold: () => new Promise(() => {}) });
    const pending = held.generate(request({ signal: second.signal }));
    setTimeout(() => second.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'invalid_context' });

    await expect(new FakeImageProvider().generate(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ code: 'invalid_context' });
  });
});

describe('FakeImageProvider prepareReferences', () => {
  const png = fakeImageBytes({ prompt: 'portrait', width: 768, height: 768 });

  it('returns a frozen handle for each recognised image and records the upload', async () => {
    const provider = new FakeImageProvider();
    const requestId = randomUUID();
    const handles = await provider.prepareReferences([png, png], { requestId });
    expect(handles).toEqual([{ provider: 'fake', requestId, index: 0 }, { provider: 'fake', requestId, index: 1 }]);
    expect(Object.isFrozen(handles[0])).toBe(true);
    expect(provider.uploads).toEqual([{ requestId, count: 2 }]);
  });

  it('gives null where failUpload says so or the bytes are not an image', async () => {
    const provider = new FakeImageProvider({ failUpload: (index) => index === 1 });
    const requestId = randomUUID();
    const handles = await provider.prepareReferences([png, png, png, new Uint8Array([1, 2, 3, 4])], { requestId });
    expect(handles).toEqual([{ provider: 'fake', requestId, index: 0 }, null, { provider: 'fake', requestId, index: 2 }, null]);
  });

  it('rejects when the signal is aborted', async () => {
    const provider = new FakeImageProvider();
    await expect(provider.prepareReferences([png], { requestId: randomUUID(), signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'invalid_context' });
    expect(provider.uploads).toHaveLength(0);
  });
});

describe('image files', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  it('stores once, reuses the file and reads it back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-images-'));
    const bytes = fakeImageBytes(request());
    const first = await storeImage(dir, bytes);
    const second = await storeImage(dir, bytes);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ contentType: 'image/png', byteLength: bytes.byteLength });
    expect(first.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(join(dir, 'images'))).toEqual([`${first.fileHash}.png`]);
    const read = await readImageFile(dir, { file_hash: first.fileHash, content_type: first.contentType });
    expect(Buffer.from(bytes)).toEqual(read);
  });

  it('rejects junk, empty and oversize bytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-images-'));
    const message = 'The picture file is not a supported image.';
    await expect(storeImage(dir, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(message);
    await expect(storeImage(dir, new Uint8Array())).rejects.toThrow(message);
    const big = new Uint8Array(8_000_001);
    big.set([0xff, 0xd8, 0xff]);
    await expect(storeImage(dir, big)).rejects.toThrow(message);
  });
});
