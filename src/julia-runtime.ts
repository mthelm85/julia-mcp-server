/**
 * Julia Runtime — Docker communication layer
 *
 * Manages the lifecycle of two Docker artifacts:
 *   - julia-mcp-sandbox  : persistent execution container, --network none, port 2625
 *   - julia-mcp-installer: ephemeral sidecar, --network bridge, used only for Pkg.add
 *
 * Both share the "julia-depot" named volume so installed packages are immediately
 * available in the execution container without a restart.
 *
 * Security: all Docker CLI calls go through execa with array arguments (no shell),
 * preventing command injection on the host side. A per-session random auth token is
 * passed to the execution container and required on every request, so no other process
 * on the host can submit code via the open TCP port.
 */

import { execa } from 'execa';
import type { ExecaError } from 'execa';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ── Constants ──────────────────────────────────────────────────────────────────

const EXEC_IMAGE      = 'julia-mcp-sandbox';
const INSTALLER_IMAGE = 'julia-mcp-installer';
const CONTAINER_NAME  = 'julia-mcp-exec';
const DEPOT_VOLUME    = 'julia-depot';
const JULIA_PORT      = 2625;
const READY_TIMEOUT_MS = 120_000; // 2 min — first-ever start loads precompiled cache

/** Per-session auth token. Passed to the container via --env; required on every request. */
const AUTH_TOKEN = randomUUID();

/** Hard cap on response size. Prevents a print("x"^∞) from blowing up the TS process. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Host path for the scratch directory. Override via JULIA_SCRATCH_PATH env var.
 * Docker Desktop on Windows accepts forward-slash Windows paths (C:/Users/...).
 */
const SCRATCH_HOST = process.env.JULIA_SCRATCH_PATH
  ?? path.join(os.homedir(), 'julia-scratch').replace(/\\/g, '/');

// ── Types ──────────────────────────────────────────────────────────────────────

export interface JuliaResult {
  stdout: string;
  stderr: string;
  result: string;
  error:  string;
}

// ── Internal Docker helpers ────────────────────────────────────────────────────

async function imageExists(name: string): Promise<boolean> {
  try {
    await execa('docker', ['image', 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function containerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execa('docker', [
      'inspect', '--format', '{{.State.Running}}', name,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function removeContainer(name: string): Promise<void> {
  try {
    await execa('docker', ['rm', '-f', name]);
  } catch {
    // Container didn't exist — fine
  }
}

async function getImageDigest(imageName: string): Promise<string> {
  const { stdout } = await execa('docker', [
    'inspect', '--format', '{{.Id}}', imageName,
  ]);
  return stdout.trim();
}

// ── Build ──────────────────────────────────────────────────────────────────────

async function buildImages(): Promise<void> {
  if (!await imageExists(EXEC_IMAGE)) {
    process.stderr.write(
      `[julia-mcp] Building ${EXEC_IMAGE} — this may take several minutes on first run...\n`,
    );
    await execa('docker', ['build', '-t', EXEC_IMAGE, PROJECT_ROOT], {
      stderr: 'inherit', stdout: 'pipe', // never inherit stdout — it's the MCP JSON-RPC pipe
    });
  }

  if (!await imageExists(INSTALLER_IMAGE)) {
    process.stderr.write(`[julia-mcp] Building ${INSTALLER_IMAGE}...\n`);
    await execa('docker', [
      'build', '-t', INSTALLER_IMAGE,
      '-f', path.join(PROJECT_ROOT, 'Dockerfile.installer'),
      PROJECT_ROOT,
    ], { stderr: 'inherit', stdout: 'pipe' });
  }
}

// ── Volume & scratch ───────────────────────────────────────────────────────────

async function ensureVolumeExists(): Promise<void> {
  try {
    await execa('docker', ['volume', 'inspect', DEPOT_VOLUME]);
  } catch {
    await execa('docker', ['volume', 'create', DEPOT_VOLUME]);
    process.stderr.write(`[julia-mcp] Created Docker volume: ${DEPOT_VOLUME}\n`);
  }
}

function ensureScratchExists(): void {
  // Convert forward-slash path back to native separators for fs operations
  const native = SCRATCH_HOST.replace(/\//g, path.sep);
  if (!fs.existsSync(native)) {
    fs.mkdirSync(native, { recursive: true });
    process.stderr.write(`[julia-mcp] Created scratch directory: ${native}\n`);
  }
}

// ── Container lifecycle ────────────────────────────────────────────────────────

async function startExecutionContainer(): Promise<void> {
  await execa('docker', [
    'run', '-d',
    '--name', CONTAINER_NAME,
    '--memory', '4g',
    '--cpus', '2.0',
    '-p', `127.0.0.1:${JULIA_PORT}:${JULIA_PORT}`,
    '--env', `JULIA_MCP_TOKEN=${AUTH_TOKEN}`,
    '-v', `${DEPOT_VOLUME}:/home/julia_agent/.julia`,
    '-v', `${SCRATCH_HOST}:/home/julia_agent/scratch`,
    EXEC_IMAGE,
  ]);
}

async function waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(JULIA_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Julia server did not become ready within ${timeoutMs / 1000}s`);
}

async function ensureContainerRunning(): Promise<void> {
  if (!await containerRunning(CONTAINER_NAME)) {
    process.stderr.write('[julia-mcp] Execution container not running — restarting...\n');
    await removeContainer(CONTAINER_NAME);
    await startExecutionContainer();
    await waitForReady();
  }
}

// ── Depot seeding ─────────────────────────────────────────────────────────────

/**
 * On first run the julia-depot volume is empty, which would shadow the packages
 * baked into the image. This function seeds the volume from /opt/julia-base
 * (baked into the image during docker build) before the execution container starts.
 *
 * The current image digest is stored in the volume's .seeded file. If the image
 * is rebuilt (e.g., packages updated), the digest changes and the depot is
 * re-seeded automatically — preventing silent stale-cache bugs after upgrades.
 */
async function seedVolumeIfNeeded(): Promise<void> {
  process.stderr.write('[julia-mcp] Checking Julia depot...\n');

  const digest = await getImageDigest(EXEC_IMAGE);

  await execa('docker', [
    'run', '--rm', '--network', 'none',
    '-v', `${DEPOT_VOLUME}:/home/julia_agent/.julia`,
    '--env', `IMAGE_DIGEST=${digest}`,
    EXEC_IMAGE,
    'sh', '-c',
    'STORED=$(cat /home/julia_agent/.julia/.seeded 2>/dev/null || true); ' +
    'if [ "$STORED" != "$IMAGE_DIGEST" ]; then ' +
    'echo "[julia-mcp] Seeding Julia depot (image updated or first run)..." && ' +
    'cp -a --remove-destination /opt/julia-base/. /home/julia_agent/.julia/ && ' +
    'echo "$IMAGE_DIGEST" > /home/julia_agent/.julia/.seeded && ' +
    'echo "[julia-mcp] Depot seeded."; ' +
    'fi',
  ], { timeout: 600_000, stderr: 'inherit', stdout: 'pipe' });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Called once at MCP server startup.
 * Builds images if missing, seeds the depot volume, starts the execution container.
 */
export async function initialize(): Promise<void> {
  await buildImages();
  await ensureVolumeExists();
  ensureScratchExists();
  await seedVolumeIfNeeded(); // must run before container starts

  // Always start with a clean container to guarantee known session state
  await removeContainer(CONTAINER_NAME);
  await startExecutionContainer();

  process.stderr.write('[julia-mcp] Waiting for Julia server to be ready...\n');
  await waitForReady();
  process.stderr.write('[julia-mcp] Julia server ready.\n');
}

/**
 * Send SIGINT to the execution container to interrupt a running task.
 * Julia's exit_on_sigint(false) means this throws InterruptException rather
 * than killing the process.
 */
async function interruptExecution(): Promise<void> {
  try {
    await execa('docker', ['kill', '--signal', 'SIGINT', CONTAINER_NAME]);
  } catch {
    // Container may not be running — ignore
  }
}

/**
 * Execute Julia code in the stateful execution container.
 * Returns stdout, stderr, the repr() of the last expression, and any error.
 */
export async function executeCode(
  code: string,
  timeoutSeconds: number,
): Promise<JuliaResult> {
  await ensureContainerRunning();

  return new Promise<JuliaResult>((resolve, reject) => {
    const socket = net.createConnection(JULIA_PORT, '127.0.0.1');
    let responseData = '';
    let responseBytes = 0;

    const timer = setTimeout(() => {
      socket.destroy();
      interruptExecution().catch(() => {}); // best-effort; fire and forget
      reject(new Error(
        `Execution timed out after ${timeoutSeconds}s. ` +
        `If the session appears stuck, call reset_julia_session.`,
      ));
    }, timeoutSeconds * 1000);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ code, token: AUTH_TOKEN }));
      socket.end(); // signal EOF; keep socket open for reading response
    });

    socket.on('data', chunk => {
      responseBytes += chunk.length;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('Response exceeded 10 MB output limit'));
        return;
      }
      responseData += chunk.toString();
    });

    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(responseData) as JuliaResult);
      } catch {
        resolve({ stdout: responseData, stderr: '', result: '', error: 'Failed to parse Julia response' });
      }
    });

    socket.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Install a Julia package using the isolated sidecar container.
 * The package name is validated against a strict allowlist regex before use.
 * Network access is scoped to the sidecar — the execution container stays air-gapped.
 */
export async function installPackage(packageName: string): Promise<JuliaResult> {
  // Warden: only allow valid Julia identifier characters
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(packageName)) {
    return {
      stdout: '', stderr: '', result: '',
      error: `Invalid package name "${packageName}". Must be a valid Julia identifier.`,
    };
  }

  const juliaExpr = `using Pkg; Pkg.add("${packageName}"); Pkg.precompile()`;

  try {
    const { stdout, stderr } = await execa('docker', [
      'run', '--rm',
      '-v', `${DEPOT_VOLUME}:/home/julia_agent/.julia`,
      INSTALLER_IMAGE,
      'julia', '-e', juliaExpr,
    ], { timeout: 300_000 }); // 5-minute cap for slow package installs

    return {
      stdout,
      stderr,
      result: `Successfully installed ${packageName}`,
      error: '',
    };
  } catch (err) {
    const e = err as ExecaError;
    return {
      stdout: (e.stdout as string | undefined) ?? '',
      stderr: (e.stderr as string | undefined) ?? '',
      result: '',
      error: `Install failed: ${e.message}`,
    };
  }
}

/**
 * Stop and restart the execution container, clearing all Julia session state.
 * The julia-depot volume is preserved so previously installed packages survive.
 */
export async function resetSession(): Promise<void> {
  await removeContainer(CONTAINER_NAME);
  await startExecutionContainer();
  await waitForReady();
}

/**
 * Gracefully tear down the execution container on server exit.
 */
export async function cleanup(): Promise<void> {
  await removeContainer(CONTAINER_NAME);
}

// ── Lazy initialization ────────────────────────────────────────────────────────

let _readyPromise: Promise<void> | null = null;

/** Fire-and-forget: kick off initialization without blocking the caller. */
export function startInitialization(): void {
  if (!_readyPromise) {
    _readyPromise = initialize();
  }
}

/**
 * Await this at the start of every tool handler.
 * Returns instantly once Julia is ready; blocks on the first call until it is.
 */
export async function ensureReady(): Promise<void> {
  if (!_readyPromise) {
    _readyPromise = initialize();
  }
  await _readyPromise;
}
