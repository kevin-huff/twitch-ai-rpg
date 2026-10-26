import { createApp, type Component } from 'vue';

type BootOptions = {
  pollMs?: number;
  timeoutMs?: number;
  reload?: () => void;
  fetch?: typeof fetch;
};

export async function boot(
  load: () => Promise<{ default: Component }>,
  options: BootOptions = {}
): Promise<void> {
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 3000;
  const reload = options.reload ?? (() => window.location.reload());
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let module: { default: Component };
  try {
    module = await load();
  } catch (error) {
    console.warn('Page code failed to load, waiting for the server before reloading.', error);
    await new Promise<void>((resolve) => {
      let finished = false;
      const poll = () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        doFetch('/health', { cache: 'no-store', signal: controller.signal })
          .then((response) => {
            if (response.ok && !finished) {
              finished = true;
              clearInterval(interval);
              reload();
              resolve();
            }
          })
          .catch(() => undefined)
          .finally(() => clearTimeout(timer));
      };
      const interval = setInterval(poll, pollMs);
    });
    return;
  }
  createApp(module.default).mount('#app');
}
