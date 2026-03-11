import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as julia from './julia-runtime.js';

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'julia-mcp-server', version: '1.0.0' });

server.tool(
  'run_julia_code',
  'Execute Julia code in a persistent, stateful sandbox. Variables, functions, and ' +
  'loaded packages persist across calls within the same session. Plots must be saved ' +
  'to /home/julia_agent/scratch/ using savefig() — they appear in your local ~/julia-scratch/.\n' +
  'Pre-installed packages (do NOT call install_julia_package for these): ' +
  'DataFrames, CSV, JSON3, JuMP, HiGHS, StatsBase, Distributions, ' +
  'CairoMakie, Turing, Revise, PackageCompiler, DaemonMode. ' +
  'Julia standard library (always available without installing): ' +
  'LinearAlgebra, Statistics, Random, Dates, Printf, Base.',
  {
    code: z.string().describe('Julia source code to execute'),
    timeout_seconds: z
      .number().int().min(1).max(300).optional().default(30)
      .describe('Execution timeout in seconds (1–300, default 30). Increase for MCMC/heavy computation.'),
  },
  async ({ code, timeout_seconds }) => {
    await julia.ensureReady();
    const result = await julia.executeCode(code, timeout_seconds);

    const parts: string[] = [];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.result) parts.push(`result: ${result.result}`);
    if (result.error)  parts.push(`error:\n${result.error}`);

    return {
      content: [{ type: 'text', text: parts.join('\n\n') || '(no output)' }],
      isError: result.error.length > 0,
    };
  },
);

server.tool(
  'install_julia_package',
  'Install a Julia package into the sandbox. Requires approval. Network access is ' +
  'scoped to the installer sidecar — the execution container remains air-gapped. ' +
  'The package is available immediately after installation without resetting the session.',
  {
    package_name: z.string().describe('Julia package name, e.g. "Symbolics" or "Flux"'),
  },
  { destructiveHint: true, readOnlyHint: false },
  async ({ package_name }) => {
    await julia.ensureReady();
    const result = await julia.installPackage(package_name);

    const parts: string[] = [];
    if (result.result) parts.push(result.result);
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    if (result.error)  parts.push(`error:\n${result.error}`);

    return {
      content: [{ type: 'text', text: parts.join('\n\n') || '(no output)' }],
      isError: result.error.length > 0,
    };
  },
);

server.tool(
  'reset_julia_session',
  'Restart the Julia execution container, clearing all session state (variables, ' +
  'function definitions, loaded modules). Use when the session is corrupted, a ' +
  '"world age" error occurs, or a clean slate is needed. Previously installed ' +
  'packages are preserved.',
  {},
  async () => {
    await julia.ensureReady();
    await julia.resetSession();
    return {
      content: [{ type: 'text', text: 'Julia session has been reset. All variables and loaded modules cleared. Installed packages are preserved.' }],
    };
  },
);

// ── Startup ────────────────────────────────────────────────────────────────────

// Connect transport FIRST so the MCP handshake completes immediately (<1s).
// Julia initialization runs in the background; tool handlers await ensureReady().
const transport = new StdioServerTransport();

process.on('SIGINT',  async () => { await julia.cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await julia.cleanup(); process.exit(0); });

await server.connect(transport);

process.stderr.write('[julia-mcp] Starting Julia sandbox in background...\n');
julia.startInitialization();
