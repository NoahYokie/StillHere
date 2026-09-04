type Task<T> = () => Promise<T>;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

class AsyncLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number, private readonly name: string) {}

  async run<T>(task: Task<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  snapshot() {
    return { name: this.name, active: this.active, queued: this.queue.length, maxConcurrent: this.maxConcurrent };
  }
}

export const twilioSmsLimiter = new AsyncLimiter(envInt("TWILIO_SMS_MAX_CONCURRENT", 5, 1, 50), "twilio_sms");
export const twilioVoiceLimiter = new AsyncLimiter(envInt("TWILIO_VOICE_MAX_CONCURRENT", 2, 1, 20), "twilio_voice");
