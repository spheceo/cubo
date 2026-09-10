import type { PlaybackUpdate } from './local-engine';

/** One request in flight and one newest pending snapshot. Rapid scrubbing
 * must not build a queue of obsolete seeks or reorder writes to Core. */
export class ProgressWriter {
  private pending: PlaybackUpdate | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly write: (update: PlaybackUpdate) => Promise<void>) {}

  enqueue(update: PlaybackUpdate): Promise<void> {
    const previous = this.pending;
    this.pending = previous ? {
      ...update,
      watchedDeltaSeconds: previous.watchedDeltaSeconds + update.watchedDeltaSeconds,
      sessionStarted: previous.sessionStarted || update.sessionStarted,
      creditsStartSeconds: update.creditsStartSeconds ?? previous.creditsStartSeconds,
    } : update;
    this.running ??= this.drain();
    return this.whenIdle();
  }

  /** Resolves only after every coalesced snapshot has been written. */
  whenIdle(): Promise<void> {
    return this.running ? this.running.then(() => this.whenIdle()) : Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const update = this.pending;
        this.pending = null;
        try {
          await this.write(update);
        } catch {
          // Local playhead persistence remains available during a Core
          // outage. A failed POST must not block subsequent snapshots.
        }
      }
    } finally {
      this.running = null;
      if (this.pending) this.running = this.drain();
    }
  }
}
