import { randomUUID } from 'node:crypto';

const TERMINAL_TYPES = new Set(['auth_success', 'auth_status', 'error', 'cancelled']);

export class Session {
  constructor({ id = randomUUID(), provider, timeoutSeconds = Number(process.env.AUTH_SESSION_TIMEOUT_SECONDS || 600) }) {
    this.id = id;
    this.provider = provider;
    this.timeoutSeconds = timeoutSeconds;
    this.events = [];
    this.waiters = new Set();
    this.finished = false;
    this.finishedAt = null;
    this.timeout = null;
  }

  start() {
    this.timeout = setTimeout(() => {
      if (!this.finished) this.fail('Authentication timed out.');
    }, Math.max(1, this.timeoutSeconds) * 1000);
    this.timeout.unref?.();

    Promise.resolve()
      .then(() => this.provider.run(this))
      .catch((error) => {
        console.warn(`[oauth-service] provider failed: ${error?.stack || error}`);
        this.pushEvent({ type: 'error', message: error?.message || 'Provider failed.' });
      })
      .finally(() => {
        if (!this.finished) {
          this.pushEvent({ type: 'error', message: 'Authentication process exited without credentials.' });
        }
        this.markFinished();
      });
  }

  isFinished() {
    return this.finished;
  }

  pushEvent(event) {
    if (this.finished) return;

    const payload = {};
    for (const [key, value] of Object.entries(event)) payload[String(key)] = value;
    this.events.push(payload);

    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }

    if (TERMINAL_TYPES.has(payload.type)) this.markFinished();
  }

  snapshot(cursor = 0) {
    const safeCursor = Math.min(Math.max(Number(cursor) || 0, 0), this.events.length);
    const authUrlEvent = this.lastEvent('auth_url_generated');
    const deviceCodeEvent = this.lastEvent('auth_device_code');
    const terminalEvent = this.lastTerminalEvent();

    return {
      session_id: this.id,
      status: this.statusFor(terminalEvent),
      cursor: this.events.length,
      events: this.events.slice(safeCursor),
      ...(authUrlEvent?.url ? { auth_url: authUrlEvent.url } : {}),
      ...(deviceCodeEvent?.code ? { device_code: deviceCodeEvent.code } : {}),
      ...(terminalEvent?.message ? { message: terminalEvent.message } : {}),
      ...(terminalEvent?.credentials ? { credentials: terminalEvent.credentials } : {}),
    };
  }

  waitForChange(cursor, timeoutMs) {
    if (cursor < this.events.length || this.finished || timeoutMs <= 0) return Promise.resolve();

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve();
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  submitCode(code) {
    this.provider.submitCode(code);
  }

  fail(message = 'Authentication failed.') {
    try {
      this.provider.cancel();
    } finally {
      if (!this.finished) this.pushEvent({ type: 'error', message });
      this.markFinished();
    }
  }

  cancel(message = 'Authentication cancelled.') {
    try {
      this.provider.cancel();
    } finally {
      if (!this.finished) this.pushEvent({ type: 'cancelled', message });
      this.markFinished();
    }
  }

  markFinished() {
    if (this.finished) return;
    this.finished = true;
    this.finishedAt = Date.now();
    if (this.timeout) clearTimeout(this.timeout);
  }

  expiredFor(retentionMs) {
    return this.finished && this.finishedAt && Date.now() - this.finishedAt > retentionMs;
  }

  lastEvent(type) {
    return this.events.findLast((event) => event.type === type);
  }

  lastTerminalEvent() {
    return this.events.findLast((event) => TERMINAL_TYPES.has(event.type));
  }

  statusFor(terminalEvent) {
    if (terminalEvent?.type === 'auth_success') return 'authenticated';
    if (terminalEvent?.type === 'auth_status') return String(terminalEvent.status || 'finished');
    if (terminalEvent?.type === 'error') return 'error';
    if (terminalEvent?.type === 'cancelled') return 'cancelled';
    if (this.lastEvent('auth_url_generated') || this.lastEvent('auth_device_code')) return 'awaiting_user';
    return 'pending';
  }
}
