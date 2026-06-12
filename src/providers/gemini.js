import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { BaseProvider } from './base.js';

const OAUTH_SETTINGS = {
  security: { auth: { selectedType: 'oauth-personal' } },
};

export class GeminiProvider extends BaseProvider {
  async run(session) {
    this.tempDir = await mkdtemp(join(tmpdir(), 'gemini-oauth-'));
    const geminiHome = join(this.tempDir, '.gemini');
    await mkdir(geminiHome, { recursive: true });
    await writeFile(join(geminiHome, 'settings.json'), JSON.stringify(OAUTH_SETTINGS));

    if (process.env.GEMINI_AUTH_TRANSPORT === 'pipe') {
      await this.runWithPipe(session, geminiHome);
      return;
    }

    await this.runWithPty(session, geminiHome);
  }

  async runWithPty(session, geminiHome) {
    let child;
    try {
      child = pty.spawn(this.geminiBin(), ['--list-sessions'], {
        env: this.envFor(),
        cols: 120,
        rows: 30,
      });
    } catch (error) {
      throw new Error(`Gemini OAuth requires a working pseudo-terminal: ${error.message}`);
    }

    this.ptyProcess = child;
    child.onData((data) => this.emitUrlOnce(session, data));

    try {
      await this.waitForPtyExit(child);
      await this.finish(session, join(geminiHome, 'oauth_creds.json'));
    } finally {
      await this.cleanup();
    }
  }

  async runWithPipe(session, geminiHome) {
    const child = spawn(this.geminiBin(), ['--list-sessions'], {
      env: this.envFor(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    this.registerChild(child);

    child.stdout.on('data', (data) => this.emitUrlOnce(session, data.toString()));
    child.stderr.on('data', (data) => this.emitUrlOnce(session, data.toString()));

    try {
      await this.waitForExit(child);
      await this.finish(session, join(geminiHome, 'oauth_creds.json'));
    } finally {
      await this.cleanup();
    }
  }

  submitCode(code) {
    const value = String(code || '');
    if (!value) return;
    if (this.ptyProcess) {
      this.ptyProcess.write(`${value}\r`);
      return;
    }
    if (!this.stdin || this.stdin.destroyed) return;
    this.stdin.write(`${value}\n`);
  }

  geminiBin() {
    return process.env.GEMINI_BIN || 'gemini';
  }

  envFor() {
    return {
      ...process.env,
      HOME: this.tempDir,
      GEMINI_CLI_HOME: this.tempDir,
      NO_BROWSER: 'true',
    };
  }

  async finish(session, credsPath) {
    try {
      const credentials = await readFile(credsPath, 'utf8');
      session.pushEvent({ type: 'auth_success', credentials: { 'oauth_creds.json': credentials } });
    } catch {
      session.pushEvent({ type: 'error', message: 'Gemini authentication did not produce oauth_creds.json.' });
    }
  }
}
