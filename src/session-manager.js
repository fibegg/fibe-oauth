import { NotFoundError } from './errors.js';
import { Session } from './session.js';

export class SessionManager {
  constructor({ finishedRetentionMs = Number(process.env.AUTH_SESSION_FINISHED_RETENTION_SECONDS || 300) * 1000 } = {}) {
    this.sessions = new Map();
    this.finishedRetentionMs = finishedRetentionMs;
  }

  create(provider) {
    this.forgetExpired();
    const session = new Session({ provider });
    this.sessions.set(session.id, session);
    session.start();
    return session;
  }

  fetch(id) {
    this.forgetExpired();
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundError('session_not_found');
    return session;
  }

  forget(id) {
    this.sessions.delete(id);
  }

  cancelAll(message = 'Authentication service stopped.') {
    for (const session of this.sessions.values()) session.cancel(message);
    this.sessions.clear();
  }

  forgetExpired() {
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiredFor(this.finishedRetentionMs)) this.sessions.delete(id);
    }
  }
}
