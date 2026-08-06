import type { Channel } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';

export interface DeliveryResult {
  channel: Channel;
  username: string;
  ok: boolean;
  error?: string;
}

export interface Notifier {
  readonly channel: Channel;
  /** Delivers one digest. Throws on failure; the caller records the outcome. */
  send(digest: Digest, rendered: RenderedDigest): Promise<void>;
  /** Optional connectivity check used by `mra test-notify`. */
  verify?(): Promise<void>;
}
