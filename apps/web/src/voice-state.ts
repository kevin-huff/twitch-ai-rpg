export type VoiceState =
  | { status: 'checking' }
  | { status: 'preparing' }
  | { status: 'ready'; preparationId: string }
  | { status: 'failed'; message: string }
  | { status: 'unavailable' };
