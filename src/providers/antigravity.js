import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import pty from 'node-pty';
import { BaseProvider } from './base.js';

const execFileAsync = promisify(execFile);

const AUTH_PROMPT = 'Authenticate Antigravity CLI and respond with "authenticated".';
const AUTH_TIMEOUT = '5m';
const GOOGLE_OAUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+/;
const AUTH_FAILURE_PATTERN = /(?:authentication timed out|authentication failed|failed to authenticate|Error:\s*authentication)/i;
const UNSUPPORTED_RUNTIME_PATTERN = /(?:compiled with lse enabled|Illegal instruction|SIGILL)/i;
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_TOTAL_BYTES = 56 * 1024;
const BASE64_CREDENTIAL_PREFIX = '__fibe_base64__:';
const CREDENTIAL_PATH_PATTERN = /(?:^|\/)(?:auth|oauth|token|credential|account|login)[^/]*(?:\.json)?$/i;
const JSON_FILE_PATTERN = /\.json$/i;
const KEYRING_PATH_PATTERN = /^\.local\/share\/keyrings\/[^/]+$/;
const SAFE_STATE_PATH_PATTERN = /^(?:projects\.json|config\/[^/]+\.json|config\/projects\/[^/]+\.json|antigravity-cli\/installation_id)$/i;
const VOLATILE_PATH_PATTERN = /(?:^|\/)(?:\.cache|cache|brain|last_conversations|conversations?|history|transcripts?|logs?|tmp|scratch)(?:[./_-]|$)/i;

export class AntigravityProvider extends BaseProvider {
  async run(session) {
    this.tempDir = await mkdtemp(join(tmpdir(), 'antigravity-oauth-'));
    const geminiHome = join(this.tempDir, '.gemini');
    const workspaceDir = join(this.tempDir, 'workspace');
    await mkdir(join(geminiHome, 'antigravity-cli', 'cache'), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await this.prepareSecretService(geminiHome);

    if (process.env.ANTIGRAVITY_AUTH_TRANSPORT === 'pipe') {
      await this.runWithPipe(session, geminiHome, workspaceDir);
      return;
    }

    await this.runWithPty(session, geminiHome, workspaceDir);
  }

  async runWithPty(session, geminiHome, workspaceDir) {
    let child;
    let output = '';
    this.session = session;
    this.geminiHome = geminiHome;
    try {
      child = pty.spawn(this.antigravityBin(), [`--prompt=${AUTH_PROMPT}`, '--print-timeout', AUTH_TIMEOUT], {
        env: this.envFor(geminiHome),
        cwd: workspaceDir,
        cols: 120,
        rows: 30,
      });
    } catch (error) {
      throw new Error(`Antigravity OAuth requires a working pseudo-terminal: ${error.message}`);
    }

    this.ptyProcess = child;
    child.onData((data) => {
      output += this.stripAnsi(data);
      this.emitGoogleUrlOnce(session, output);
    });

    try {
      const exitCode = await this.waitForPtyExit(child);
      await this.finish(session, exitCode, geminiHome, output);
    } finally {
      await this.cleanup();
    }
  }

  async runWithPipe(session, geminiHome, workspaceDir) {
    this.session = session;
    this.geminiHome = geminiHome;
    const child = spawn(this.antigravityBin(), [`--prompt=${AUTH_PROMPT}`, '--print-timeout', AUTH_TIMEOUT], {
      env: this.envFor(geminiHome),
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    this.registerChild(child);

    let output = '';
    const onData = (data) => {
      output += this.stripAnsi(data.toString());
      this.emitGoogleUrlOnce(session, output);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    try {
      const exitCode = await this.waitForExit(child);
      await this.finish(session, exitCode, geminiHome, output);
    } finally {
      await this.cleanup();
    }
  }

  submitCode(code) {
    const value = String(code || '').trim();
    if (!value) return;
    if (this.ptyProcess) {
      this.ptyProcess.write(`${value}\r`);
      this.startCredentialWatcher();
      return;
    }
    if (!this.stdin || this.stdin.destroyed) return;
    this.stdin.write(`${value}\n`);
    this.startCredentialWatcher();
  }

  antigravityBin() {
    return process.env.ANTIGRAVITY_BIN || 'agy';
  }

  envFor(geminiHome) {
    return {
      ...process.env,
      HOME: this.tempDir,
      ANTIGRAVITY_HOME: geminiHome,
      SESSION_DIR: geminiHome,
      XDG_CONFIG_HOME: join(geminiHome, '.config'),
      XDG_DATA_HOME: join(geminiHome, '.local', 'share'),
      XDG_STATE_HOME: join(geminiHome, '.local', 'state'),
      XDG_CACHE_HOME: join(geminiHome, '.cache'),
      BROWSER: '/bin/true',
      DISPLAY: '',
      NO_BROWSER: 'true',
    };
  }

  async prepareSecretService(geminiHome) {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return;

    await mkdir(join(geminiHome, '.local', 'share', 'keyrings'), { recursive: true });
    try {
      await execFileAsync('sh', [
        '-lc',
        'printf "\\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 || true; gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1 || true',
      ], { env: this.envFor(geminiHome) });
    } catch {
    }
  }

  emitGoogleUrlOnce(session, text) {
    if (this.urlSent) return;
    const match = String(text).match(GOOGLE_OAUTH_URL_PATTERN);
    if (!match) return;

    this.urlSent = true;
    session.pushEvent({ type: 'auth_url_generated', url: match[0] });
  }

  async finish(session, exitCode, geminiHome, output) {
    this.stopCredentialWatcher();
    if (this.authCompleted) return;

    if (exitCode === 132 || UNSUPPORTED_RUNTIME_PATTERN.test(output)) {
      session.pushEvent({
        type: 'error',
        message: 'Antigravity CLI cannot run on this Marquee CPU. The current Linux ARM64 binary requires ARM LSE support.',
      });
      return;
    }

    if (exitCode !== 0 || AUTH_FAILURE_PATTERN.test(output)) {
      session.pushEvent({ type: 'auth_status', status: 'unauthenticated' });
      return;
    }

    const credentials = await this.collectCredentialFiles(geminiHome);
    if (Object.keys(credentials).length === 0) {
      session.pushEvent({ type: 'error', message: 'Antigravity authentication did not produce credential files.' });
      return;
    }

    session.pushEvent({ type: 'auth_success', credentials });
  }

  startCredentialWatcher() {
    if (this.credentialWatcher) return;
    this.credentialWatcher = setInterval(() => {
      void this.completeIfCredentialsReady();
    }, 1_000);
    this.credentialWatcher.unref?.();
  }

  stopCredentialWatcher() {
    if (!this.credentialWatcher) return;
    clearInterval(this.credentialWatcher);
    this.credentialWatcher = null;
  }

  async completeIfCredentialsReady() {
    if (this.authCompleted || !this.session || !this.geminiHome) return;

    const credentials = await this.collectCredentialFiles(this.geminiHome);
    if (Object.keys(credentials).length === 0) return;

    this.authCompleted = true;
    this.stopCredentialWatcher();
    this.session.pushEvent({ type: 'auth_success', credentials });
    this.terminateProcess();
  }

  async collectCredentialFiles(rootDir) {
    const files = await this.collectCredentialCandidates(rootDir, rootDir);
    const credentials = {};
    let totalBytes = 0;

    for (const file of files.sort((a, b) => this.credentialPathRank(a.relativePath) - this.credentialPathRank(b.relativePath))) {
      const content = await this.readCredentialFile(file);
      const encodedBytes = Buffer.byteLength(content, 'utf8');
      if (totalBytes + encodedBytes > MAX_CREDENTIAL_TOTAL_BYTES) continue;
      credentials[file.relativePath] = content;
      totalBytes += encodedBytes;
    }

    return credentials;
  }

  async collectCredentialCandidates(rootDir, currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = [];

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      const relativePath = relative(rootDir, absolutePath).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('../') || relativePath === '..') continue;

      if (entry.isDirectory()) {
        files.push(...await this.collectCredentialCandidates(rootDir, absolutePath));
        continue;
      }
      if (!entry.isFile() || VOLATILE_PATH_PATTERN.test(relativePath)) continue;
      if (!this.credentialCandidatePath(relativePath)) continue;

      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_CREDENTIAL_FILE_BYTES) continue;

      files.push({ absolutePath, relativePath, size: fileStat.size });
    }

    return files;
  }

  credentialPathRank(relativePath) {
    if (KEYRING_PATH_PATTERN.test(relativePath)) return 0;
    if (CREDENTIAL_PATH_PATTERN.test(relativePath)) return 0;
    if (SAFE_STATE_PATH_PATTERN.test(relativePath)) return 5;
    if (JSON_FILE_PATTERN.test(relativePath)) return 20;
    return 20;
  }

  credentialCandidatePath(relativePath) {
    return KEYRING_PATH_PATTERN.test(relativePath) ||
      CREDENTIAL_PATH_PATTERN.test(relativePath) ||
      SAFE_STATE_PATH_PATTERN.test(relativePath);
  }

  async readCredentialFile(file) {
    if (!KEYRING_PATH_PATTERN.test(file.relativePath)) return readFile(file.absolutePath, 'utf8');

    const bytes = await readFile(file.absolutePath);
    return `${BASE64_CREDENTIAL_PREFIX}${bytes.toString('base64')}`;
  }
}
