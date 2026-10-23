import type { FastifyRequest } from 'fastify';
import { AppError } from './repository';

function invalidIdentity(): never {
  throw new AppError(401, 'unauthorized', 'The selected browser identity is missing or invalid.');
}

export function selectIdentity(...selectors: unknown[]): string | undefined {
  const supplied = selectors.filter((value) => value !== undefined);
  for (const value of supplied) {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) invalidIdentity();
  }
  if (new Set(supplied).size > 1) invalidIdentity();
  return supplied[0] as string | undefined;
}

export const identityCookieName = (identityId?: string) => identityId === undefined ? 'rpg_session' : `rpg_tab_${identityId}`;

export function selectCredential(cookies: Record<string, string | undefined>, identityId?: string) {
  const name = identityCookieName(identityId);
  const token = cookies[name];
  if (identityId !== undefined && !token) invalidIdentity();
  return { name, token };
}

export function requestIdentity(url: string, header: unknown, additional?: unknown) {
  const query = new URL(url, 'http://localhost').searchParams.getAll('identity');
  if (query.length > 1) invalidIdentity();
  return selectIdentity(header, query[0], additional);
}

export function httpCredential(request: FastifyRequest) {
  return selectCredential(request.cookies, requestIdentity(request.url, request.headers['x-rpg-identity']));
}
