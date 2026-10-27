import { identityPath } from './identity';

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = identityPath(path);
  if (options.replace) window.location.replace(target);
  else window.location.assign(target);
}

export function clearIdentity(): void {
  const target = new URL(window.location.href);
  if (!target.searchParams.has('identity')) return;
  target.searchParams.delete('identity');
  window.history.replaceState(window.history.state, '', `${target.pathname}${target.search}${target.hash}`);
}
