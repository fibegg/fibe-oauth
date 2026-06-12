import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseProvider } from './base.js';

const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{3,5}-[A-Z0-9]{3,5})\b/;

export class OpenaiCodexProvider extends BaseProvider {
  constructor() {
    super();
    this.deviceCodeSent = false;
  }

  async run(session) {
    this.tempDir = await mkdtemp(join(tmpdir(), 'codex-oauth-'));
    const codexHome = join(this.tempDir, '.codex');
    await mkdir(codexHome, { recursive: true });

    const child = spawn(this.codexBin(), ['login', '--device-auth'], {
      env: this.envFor(codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    this.registerChild(child);

    const onData = (data) => this.readChunk(session, data.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    try {
      const exitCode = await this.waitForExit(child);
      await this.finish(session, exitCode, join(codexHome, 'auth.json'));
    } finally {
      await this.cleanup();
    }
  }

  codexBin() {
    return process.env.CODEX_BIN || 'codex';
  }

  envFor(codexHome) {
    return {
      ...process.env,
      HOME: this.tempDir,
      CODEX_HOME: codexHome,
    };
  }

  readChunk(session, text) {
    const clean = this.stripAnsi(text).trim();
    this.emitUrlOnce(session, clean);
    this.emitDeviceCodeOnce(session, clean);
  }

  emitDeviceCodeOnce(session, text) {
    if (this.deviceCodeSent) return;
    const match = String(text).match(DEVICE_CODE_PATTERN);
    if (!match) return;

    this.deviceCodeSent = true;
    session.pushEvent({ type: 'auth_device_code', code: match[1] });
  }

  async finish(session, exitCode, credsPath) {
    if (exitCode === 0) {
      try {
        const credentials = await readFile(credsPath, 'utf8');
        session.pushEvent({ type: 'auth_success', credentials: { 'auth.json': credentials } });
        return;
      } catch {
        /* fall through to unauthenticated */
      }
    }
    session.pushEvent({ type: 'auth_status', status: 'unauthenticated' });
  }
}
