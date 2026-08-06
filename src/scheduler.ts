import { Cron } from 'croner';
import type { ConfigProvider } from './config/effective.js';
import type { Audit } from './db/audit.js';
import type { Repo } from './db/repo.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { executeRun, type RunSummary } from './run.js';

export interface SchedulerOptions {
  dryRun?: boolean;
  logger?: Logger;
}

/**
 * Runs the cycle on the configured cron expression, in the configured timezone.
 *
 * The schedule is re-read from the effective config on every tick, so changing the
 * cron in the admin panel takes effect without a restart. Overlapping runs are
 * prevented — a slow GitLab must not stack up cycles.
 */
export class Scheduler {
  private job: Cron | null = null;
  private running = false;
  private readonly log: Logger;
  private currentExpression: string | null = null;
  private currentTimezone: string | null = null;

  constructor(
    private readonly provider: ConfigProvider,
    private readonly repo: Repo,
    private readonly audit: Audit,
    private readonly options: SchedulerOptions = {},
  ) {
    this.log = options.logger ?? rootLogger;
  }

  start(): void {
    this.reschedule();
    const config = this.provider.resolve();
    if (config.schedule.run_on_start) {
      this.log.info('run_on_start is set; running immediately');
      void this.trigger('schedule');
    }
  }

  /** Applies the current cron settings, replacing the job when they have changed. */
  reschedule(): void {
    const { cron, timezone } = this.provider.resolve().schedule;
    if (this.job && cron === this.currentExpression && timezone === this.currentTimezone) return;

    this.job?.stop();
    try {
      this.job = new Cron(cron, { timezone, protect: true }, () => {
        void this.trigger('schedule');
      });
    } catch (err) {
      this.log.error(
        { cron, timezone, err: (err as Error).message },
        'invalid schedule; keeping the previous one',
      );
      return;
    }

    this.currentExpression = cron;
    this.currentTimezone = timezone;
    this.log.info({ cron, timezone, next: this.nextRun()?.toISOString() }, 'schedule set');
  }

  nextRun(): Date | null {
    return this.job?.nextRun() ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Runs one cycle. Returns null when a cycle is already in flight, which is what the
   * panel's "Run now" button reports back to the operator.
   */
  async trigger(
    trigger: 'schedule' | 'manual',
    overrides: { dryRun?: boolean } = {},
  ): Promise<RunSummary | null> {
    if (this.running) {
      this.log.warn('a run is already in progress; skipping this trigger');
      return null;
    }

    this.running = true;
    try {
      // Picked up here so a cron edit in the panel applies from the next tick.
      this.reschedule();
      return await executeRun(this.provider, this.repo, this.audit, {
        trigger,
        dryRun: overrides.dryRun ?? this.options.dryRun ?? false,
        logger: this.log,
      });
    } catch (err) {
      // executeRun has already recorded and logged the failure; the loop survives it.
      this.log.error({ err: (err as Error).message }, 'scheduled run failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }
}
