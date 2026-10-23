function validateIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('This tab’s identity is invalid. Reopen its original session link or sign in from the home page.');
}

export function getIdentity(): string | undefined {
  const values = new URLSearchParams(window.location.search).getAll('identity');
  if (!values.length) return undefined;
  if (values.length !== 1) throw new Error('This tab’s identity is invalid. Reopen its original session link.');
  validateIdentity(values[0]);
  return values[0];
}

export function identityHeaders(): Record<string, string> {
  const identity = getIdentity();
  return identity ? { 'X-RPG-Identity': identity } : {};
}

export function identityPath(path: string): string {
  const target = new URL(path, window.location.origin);
  if (target.origin !== window.location.origin) throw new Error('Identity navigation must stay on the same origin.');
  target.searchParams.delete('identity');
  for (const identity of new URLSearchParams(window.location.search).getAll('identity')) target.searchParams.append('identity', identity);
  return `${target.pathname}${target.search}${target.hash}`;
}

export function selectIdentity(identity: unknown) {
  validateIdentity(identity);
  const target = new URL(window.location.href);
  target.searchParams.set('identity', identity);
  window.history.replaceState(window.history.state, '', `${target.pathname}${target.search}${target.hash}`);
}
