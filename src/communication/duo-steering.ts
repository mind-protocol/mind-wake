import { randomUUID } from "node:crypto";
import { claimDuoReminder, finishDuoReminder } from "./duo-reminder.js";
/** Live coach turn only. No turn is created; unsupported steering stops this delivery path. */
export class DuoSteering {
  private timer: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  constructor(
    private readonly dataDir: string,
    private readonly active: () => boolean,
    private readonly send: (text: string) => Promise<boolean>,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, 250);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    if (this.stopped || this.busy || !this.active()) return;
    this.busy = true;
    const claim = randomUUID();
    let claimed = false;
    try {
      const text = claimDuoReminder(this.dataDir, claim);
      if (!text) return;
      claimed = true;
      const accepted = await this.send(text);
      finishDuoReminder(this.dataDir, claim, accepted && !this.stopped && this.active());
      claimed = false;
      if (!accepted) this.stop();
    } catch {
      if (claimed) finishDuoReminder(this.dataDir, claim, false);
      this.stop();
    } finally {
      this.busy = false;
    }
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
