import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLEWDR_WAIT, createClewdrFetch } from '../src/clewdr-fetch';

// A local server that sends no headers until the wait is over, like ClewdR answering a long call that is not streamed.
async function answeringAfter(waitMs: number): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    const timer = setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); }, waitMs);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/messages` };
}

describe('the ClewdR fetch', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('turns off both of the HTTP client\'s waiting limits by default', () => {
    expect(CLEWDR_WAIT).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
  });

  it('waits for a reply that is slow to start', async () => {
    const slow = await answeringAfter(1200); server = slow.server;
    const response = await createClewdrFetch()(slow.url, { method: 'POST', body: '{}' });
    expect(await response.json()).toEqual({ ok: true });
  });

  it('applies the waiting limits it is given', async () => {
    const slow = await answeringAfter(1200); server = slow.server;
    await expect(createClewdrFetch({ headersTimeout: 200, bodyTimeout: 200 })(slow.url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('still stops when the request is aborted', async () => {
    const slow = await answeringAfter(5000); server = slow.server;
    const controller = new AbortController();
    const call = createClewdrFetch()(slow.url, { method: 'POST', body: '{}', signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
