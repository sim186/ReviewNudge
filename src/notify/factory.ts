import type { EffectiveConfig } from '../config/effective.js';
import { CHANNELS, type Channel } from '../config/schema.js';
import { ConsoleNotifier } from './console.js';
import { EmailNotifier } from './email.js';
import { SlackNotifier } from './slack.js';
import { TeamsNotifier } from './teams.js';
import { TelegramNotifier } from './telegram.js';
import type { Notifier } from './types.js';

/**
 * Builds the live notifier for each channel.
 *
 * Kept apart from `channels.ts` so that domain code can read channel metadata without
 * importing nodemailer and the HTTP clients — this module is only reached from the run
 * cycle and the CLI.
 */
const FACTORIES: Record<Channel, (config: EffectiveConfig) => Notifier | null> = {
  email: (config) => (config.email ? new EmailNotifier(config.email) : null),
  teams: (config) => (config.teams ? new TeamsNotifier(config.teams) : null),
  slack: (config) => (config.slack ? new SlackNotifier(config.slack) : null),
  telegram: (config) => (config.telegram ? new TelegramNotifier(config.telegram) : null),
};

/** True when the channel has a configuration section to work from. */
export function isChannelConfigured(config: EffectiveConfig, channel: Channel): boolean {
  return config[channel] !== undefined;
}

/** The channels that are both switched on and actually configured. */
export function availableChannels(config: EffectiveConfig): Channel[] {
  return config.notifications.channels.filter((c) => isChannelConfigured(config, c));
}

export function buildNotifiers(config: EffectiveConfig, dryRun: boolean): Map<Channel, Notifier> {
  const notifiers = new Map<Channel, Notifier>();

  for (const channel of CHANNELS) {
    if (!config.notifications.channels.includes(channel)) continue;

    if (dryRun) {
      notifiers.set(channel, new ConsoleNotifier(channel));
      continue;
    }
    const notifier = FACTORIES[channel](config);
    if (notifier) notifiers.set(channel, notifier);
  }

  return notifiers;
}
