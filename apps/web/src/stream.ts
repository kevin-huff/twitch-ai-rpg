import type { StreamAudio, StreamLayout } from '@rpg/contracts';

export function streamUrl(origin: string, token: string, options: { layout: StreamLayout; audio: StreamAudio }): string {
  return `${origin}/stream?layout=${options.layout}&audio=${options.audio}#token=${encodeURIComponent(token)}`;
}

export function producerUrl(origin: string, token: string): string {
  return `${origin}/producer#token=${encodeURIComponent(token)}`;
}

export function readHashToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token ? token : null;
}

export function parseStreamLocation(location: { search: string; hash: string }) {
  const query = new URLSearchParams(location.search);
  const audio = query.get('audio');
  return {
    token: readHashToken(location.hash),
    layout: (query.get('layout') === 'overlay' ? 'overlay' : 'scene') as StreamLayout,
    audio: (audio === 'present' || audio === 'listen' || audio === 'off' ? audio : null) as StreamAudio | null,
    checker: query.get('bg') === 'checker',
    check: query.get('check') === '1',
  };
}
