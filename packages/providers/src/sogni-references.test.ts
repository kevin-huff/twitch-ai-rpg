import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError, SogniImageProvider } from './index.js';

const key = 'sogni-private-key-SENTINEL';
const requestId = '3f2b8c1e-7d4a-4f6b-9c2e-1a5d8e7f6b4c';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const uploadLink = (slot: number) => `https://r2.sogni.test/uploads/${requestId}/contextImage${slot}?X-Amz-Signature=up-SECRET-${slot}`;
const downloadLink = (slot: number) => `https://media-input.sogni.test/${requestId}/contextImage${slot}?sig=down-SECRET-${slot}`;
const query = (slot: number, contentType: string) => `type=contextImage${slot}&jobId=${requestId}&contentType=${encodeURIComponent(contentType)}`;

type Step = 'uploadUrl' | 'put' | 'downloadUrl';
type Script = Partial<Record<Step, (slot: number, attempt: number) => Response | Promise<Response>>>;

function sogniFetch(script: Script = {}) {
  const attempts = new Map<string, number>();
  const next = (step: Step, slot: number) => {
    const name = `${step}:${slot}`;
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    return attempt;
  };
  return vi.fn<typeof fetch>(async (url) => {
    const target = new URL(String(url));
    const slot = Number(target.searchParams.get('type')?.replace('contextImage', '') ?? target.pathname.match(/contextImage(\d+)/)?.[1]);
    if (target.href.startsWith('https://api.sogni.test/v1/image/uploadUrl?')) {
      const attempt = next('uploadUrl', slot);
      return script.uploadUrl?.(slot, attempt) ?? Response.json({ status: 'success', data: { uploadUrl: uploadLink(slot) } });
    }
    if (target.href.startsWith('https://r2.sogni.test/')) {
      const attempt = next('put', slot);
      return script.put?.(slot, attempt) ?? new Response(null, { status: 200 });
    }
    if (target.href.startsWith('https://api.sogni.test/v1/image/downloadUrl?')) {
      const attempt = next('downloadUrl', slot);
      return script.downloadUrl?.(slot, attempt) ?? Response.json({ status: 'success', data: { downloadUrl: downloadLink(slot) } });
    }
    throw new Error(`unexpected fetch ${target.href}`);
  });
}

const provider = (fetchMock: typeof fetch) => new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, pollMs: 1 });
const calls = (fetchMock: ReturnType<typeof sogniFetch>) => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init! }));

describe('SogniImageProvider.prepareReferences', () => {
  it('runs upload link, PUT and download link for each picture with the exact URLs and queries', async () => {
    const fetchMock = sogniFetch();
    const handles = await provider(fetchMock).prepareReferences([jpeg, png], { requestId });
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle !== null && handle.provider === 'sogni')).toBe(true);
    const urls = calls(fetchMock).map((call) => call.url);
    expect(urls).toHaveLength(6);
    expect(urls).toEqual(expect.arrayContaining([
      `https://api.sogni.test/v1/image/uploadUrl?${query(1, 'image/jpeg')}`,
      uploadLink(1),
      `https://api.sogni.test/v1/image/downloadUrl?${query(1, 'image/jpeg')}`,
      `https://api.sogni.test/v1/image/uploadUrl?${query(2, 'image/png')}`,
      uploadLink(2),
      `https://api.sogni.test/v1/image/downloadUrl?${query(2, 'image/png')}`,
    ]));
    const first = urls.filter((url) => url.includes('contextImage1'));
    expect(first).toEqual([
      `https://api.sogni.test/v1/image/uploadUrl?${query(1, 'image/jpeg')}`,
      uploadLink(1),
      `https://api.sogni.test/v1/image/downloadUrl?${query(1, 'image/jpeg')}`,
    ]);
  });

  it('works on the pictures in parallel', async () => {
    let open = 0;
    let peak = 0;
    const fetchMock = sogniFetch({
      uploadUrl: async (slot) => {
        open += 1; peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open -= 1;
        return Response.json({ data: { uploadUrl: uploadLink(slot) } });
      },
    });
    await provider(fetchMock).prepareReferences([jpeg, jpeg, jpeg], { requestId });
    expect(peak).toBe(3);
  });

  it('sends the key only on api calls and never to the storage host', async () => {
    const fetchMock = sogniFetch();
    await provider(fetchMock).prepareReferences([jpeg], { requestId });
    for (const { url, init } of calls(fetchMock)) {
      const headers = init.headers as Record<string, string>;
      if (url.startsWith('https://api.sogni.test/')) {
        expect(init.method).toBe('GET');
        expect(headers).toMatchObject({ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'twitch-ai-rpg/1.0' });
      } else {
        expect(JSON.stringify(headers)).not.toContain(key);
        expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization');
      }
    }
  });

  it('PUTs the raw bytes with only the content type and user agent', async () => {
    const fetchMock = sogniFetch();
    await provider(fetchMock).prepareReferences([png], { requestId });
    const put = calls(fetchMock).find((call) => call.url === uploadLink(1))!;
    expect(put.init.method).toBe('PUT');
    expect(put.init.headers).toEqual({ 'content-type': 'image/png', 'user-agent': 'twitch-ai-rpg/1.0' });
    expect(put.init.body).toEqual(png);
  });

  it('refuses redirects on every call and gives each call its own signal', async () => {
    const fetchMock = sogniFetch();
    await provider(fetchMock).prepareReferences([jpeg], { requestId });
    for (const { init } of calls(fetchMock)) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([
    ['a network error', () => { throw new TypeError('fetch failed'); }],
    ['a 429', () => new Response(null, { status: 429 })],
    ['a 503', () => new Response(null, { status: 503 })],
  ])('retries each step once after %s and then succeeds', async (_name, fail) => {
    const failOnce = (ok: () => Response) => (_slot: number, attempt: number) => attempt === 1 ? fail() : ok();
    const fetchMock = sogniFetch({
      uploadUrl: failOnce(() => Response.json({ data: { uploadUrl: uploadLink(1) } })),
      put: failOnce(() => new Response(null, { status: 200 })),
      downloadUrl: failOnce(() => Response.json({ data: { downloadUrl: downloadLink(1) } })),
    });
    const started = performance.now();
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(handle).toMatchObject({ provider: 'sogni' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(performance.now() - started).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  it.each<[Step, () => Response]>([
    ['uploadUrl', () => new Response(null, { status: 500 })],
    ['put', () => new Response(null, { status: 502 })],
    ['downloadUrl', () => new Response(null, { status: 429 })],
  ])('gives null after %s fails twice, and the other pictures still get handles', async (step, fail) => {
    const fetchMock = sogniFetch({ [step]: (slot: number) => slot === 1 ? fail() : undefined } as Script);
    const handles = await provider(fetchMock).prepareReferences([jpeg, png], { requestId });
    expect(handles[0]).toBeNull();
    expect(handles[1]).toMatchObject({ provider: 'sogni' });
    const stepUrl = step === 'put' ? uploadLink(1) : `https://api.sogni.test/v1/image/${step}?${query(1, 'image/jpeg')}`;
    expect(calls(fetchMock).filter((call) => call.url === stepUrl)).toHaveLength(2);
  }, 10_000);

  it.each([400, 401, 403, 404])('gives null at once, with no retry, when a step answers %i', async (status) => {
    const fetchMock = sogniFetch({ uploadUrl: () => new Response(null, { status }) });
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(handle).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives null for an upload link that is not https and sends it no bytes', async () => {
    const fetchMock = sogniFetch({ uploadUrl: () => Response.json({ data: { uploadUrl: 'http://r2.sogni.test/uploads/plain' } }) });
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(handle).toBeNull();
    expect(calls(fetchMock).map((call) => call.url)).toEqual([`https://api.sogni.test/v1/image/uploadUrl?${query(1, 'image/jpeg')}`]);
  });

  it('gives null for a download link that is not https', async () => {
    const fetchMock = sogniFetch({ downloadUrl: () => Response.json({ data: { downloadUrl: 'http://media-input.sogni.test/plain' } }) });
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(handle).toBeNull();
  });

  it('gives null for an answer without a link', async () => {
    const fetchMock = sogniFetch({ uploadUrl: () => Response.json({ data: {} }) });
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(handle).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives null with no calls for bytes that are not a picture, keeping input order', async () => {
    const fetchMock = sogniFetch();
    const handles = await provider(fetchMock).prepareReferences([new TextEncoder().encode('not a picture'), jpeg], { requestId });
    expect(handles[0]).toBeNull();
    expect(handles[1]).toMatchObject({ provider: 'sogni' });
    expect(calls(fetchMock).some((call) => call.url.includes('contextImage1'))).toBe(false);
    expect(calls(fetchMock).filter((call) => call.url.includes('contextImage2'))).toHaveLength(3);
  });

  it('returns an empty list for no pictures', async () => {
    const fetchMock = sogniFetch();
    await expect(provider(fetchMock).prepareReferences([], { requestId })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws invalid_input for a request id that is not a UUID', async () => {
    const fetchMock = sogniFetch();
    await expect(provider(fetchMock).prepareReferences([jpeg], { requestId: 'scene-1' }))
      .rejects.toMatchObject({ name: 'ProviderError', code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws invalid_input for an entry that is not bytes', async () => {
    const fetchMock = sogniFetch();
    await expect(provider(fetchMock).prepareReferences(['nope' as unknown as Uint8Array], { requestId }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws invalid_context with no fetch when the signal is already aborted', async () => {
    const fetchMock = sogniFetch();
    await expect(provider(fetchMock).prepareReferences([jpeg], { requestId, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'invalid_context' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws invalid_context promptly when the caller aborts mid-chain', async () => {
    const controller = new AbortController();
    const fetchMock = sogniFetch({ put: () => { controller.abort(); return new Promise<Response>(() => {}); } });
    const started = performance.now();
    const result = provider(fetchMock).prepareReferences([jpeg, png], { requestId, signal: controller.signal });
    await expect(result).rejects.toBeInstanceOf(ProviderError);
    await expect(result).rejects.toMatchObject({ code: 'invalid_context' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('throws invalid_context when the caller aborts during the retry pause', async () => {
    const controller = new AbortController();
    const fetchMock = sogniFetch({ uploadUrl: () => { setTimeout(() => controller.abort(), 20); return new Response(null, { status: 503 }); } });
    await expect(provider(fetchMock).prepareReferences([jpeg], { requestId, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'invalid_context' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives null when a call outlasts its own deadline', async () => {
    const fetchMock = sogniFetch({ downloadUrl: () => new Promise<Response>(() => {}) });
    const slow = new SogniImageProvider({ apiKey: key, baseUrl: 'https://api.sogni.test', fetch: fetchMock, requestTimeoutMs: 100 });
    const [handle] = await slow.prepareReferences([jpeg], { requestId });
    expect(handle).toBeNull();
  });

  it('hides the signed links from JSON, String and inspect, and keeps them out of errors', async () => {
    const fetchMock = sogniFetch();
    const [handle] = await provider(fetchMock).prepareReferences([jpeg], { requestId });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).toBe('{"provider":"sogni"}');
    for (const shown of [JSON.stringify(handle), String(handle), inspect(handle, { showHidden: true, depth: 5 }), JSON.stringify(Object.getOwnPropertyNames(handle))]) {
      expect(shown).not.toContain('SECRET');
      expect(shown).not.toContain('sogni.test');
    }
    expect(Object.getOwnPropertySymbols(handle!)).toEqual([]);

    const failing = sogniFetch({ put: () => new Response(null, { status: 403 }) });
    const errors = vi.spyOn(console, 'error');
    const warnings = vi.spyOn(console, 'warn');
    const logs = vi.spyOn(console, 'log');
    try {
      await expect(provider(failing).prepareReferences([jpeg], { requestId })).resolves.toEqual([null]);
      for (const spy of [errors, warnings, logs]) expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
    } finally {
      errors.mockRestore(); warnings.mockRestore(); logs.mockRestore();
    }
  });
});
