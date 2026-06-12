import { rm } from 'node:fs/promises';

const URL_PATTERN = /https:\/\/[^\s\u001b"'>]+/;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[a-zA-Z]/g;

export class BaseProvider {
  constructor() {
    this.child = null;
    this.ptyProcess = null;
    this.stdin = null;
    this.tempDir = null;
    this.urlSent = false;
  }

  submitCode(_code) {}

  cancel() {
    this.terminateProcess();
    void this.cleanup();
  }

  emitUrlOnce(session, text) {
    if (this.urlSent) return;
    const match = String(text).match(URL_PATTERN);
    if (!match) return;

    this.urlSent = true;
    session.pushEvent({ type: 'auth_url_generated', url: match[0] });
  }

  stripAnsi(text) {
    return String(text).replace(ANSI_PATTERN, '');
  }

  registerChild(child) {
    this.child = child;
    this.stdin = child.stdin;
    child.on('error', () => {
      this.child = null;
      this.stdin = null;
    });
  }

  terminateProcess() {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill('SIGTERM');
      } catch {
        /* process already exited */
      }
      const processRef = this.ptyProcess;
      const timer = setTimeout(() => {
        try {
          processRef.kill('SIGKILL');
        } catch {
          /* process already exited */
        }
      }, 2_000);
      timer.unref?.();
      return;
    }

    const pid = this.child?.pid;
    if (!pid) return;

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* process already exited */
      }
    }
  }

  waitForExit(child) {
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  }

  waitForPtyExit(ptyProcess) {
    return new Promise((resolve) => {
      ptyProcess.onExit(({ exitCode }) => resolve(exitCode ?? 1));
    });
  }

  async cleanup() {
    try {
      if (this.stdin && !this.stdin.destroyed) this.stdin.destroy();
    } catch {
      /* ignore */
    }
    this.child = null;
    this.ptyProcess = null;
    this.stdin = null;
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }
}
