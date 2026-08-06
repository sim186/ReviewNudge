import { CHANNELS, type Channel } from '../config/schema.js';
import type { RecipientRow } from '../db/repo.js';

/**
 * One place describing every delivery channel.
 *
 * Before this existed, each channel needed its own branch in `resolveChannels`, in
 * `buildNotifiers`, in the console notifier, and in the recipients form — so adding a
 * channel meant touching four files and was easy to half-finish. Everything that
 * varies per channel and does *not* need the notifier itself lives here; the notifier
 * construction is in `factory.ts`, kept separate so domain code can import this
 * metadata without pulling in nodemailer and friends.
 */
export interface ChannelSpec {
  id: Channel;
  /** Shown in the admin panel and in logs. */
  label: string;
  /** Where this person's digest would go, or null when they are not addressable. */
  address(recipient: RecipientRow): string | null;
  /** Applies an address entered in the admin panel. */
  withAddress(recipient: RecipientRow, address: string | null): RecipientRow;
  /** The recipient form field for this channel. */
  field: {
    name: keyof RecipientRow & string;
    label: string;
    type: 'email' | 'text';
    placeholder: string;
    /** One line of help, for anything non-obvious about the identifier. */
    hint?: string;
  };
}

export const CHANNEL_SPECS: Record<Channel, ChannelSpec> = {
  email: {
    id: 'email',
    label: 'Email',
    address: (r) => r.email,
    withAddress: (r, address) => ({ ...r, email: address }),
    field: { name: 'email', label: 'Email', type: 'email', placeholder: 'someone@example.com' },
  },
  teams: {
    id: 'teams',
    label: 'Teams',
    address: (r) => r.teams_upn,
    withAddress: (r, address) => ({ ...r, teams_upn: address }),
    field: {
      name: 'teams_upn',
      label: 'Teams UPN',
      type: 'text',
      placeholder: 'someone@example.com',
      hint: 'The user principal name your Power Automate flow routes on.',
    },
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    address: (r) => r.slack_id,
    withAddress: (r, address) => ({ ...r, slack_id: address }),
    field: {
      name: 'slack_id',
      label: 'Slack member ID',
      type: 'text',
      placeholder: 'U012ABCDEF',
      hint: 'Slack profile → More → Copy member ID. Not the @handle.',
    },
  },
  telegram: {
    id: 'telegram',
    label: 'Telegram',
    address: (r) => r.telegram_chat_id,
    withAddress: (r, address) => ({ ...r, telegram_chat_id: address }),
    field: {
      name: 'telegram_chat_id',
      label: 'Telegram chat ID',
      type: 'text',
      placeholder: '123456789',
      hint: 'The person must message the bot once before a chat ID exists.',
    },
  },
};

export const CHANNEL_LIST: ChannelSpec[] = CHANNELS.map((c) => CHANNEL_SPECS[c]);

/** Where a digest for this person would be delivered on the given channel. */
export function addressFor(recipient: RecipientRow, channel: Channel): string | null {
  return CHANNEL_SPECS[channel].address(recipient);
}

export function channelLabel(channel: Channel): string {
  return CHANNEL_SPECS[channel].label;
}
