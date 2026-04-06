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
  'to /home/julia_agent/scratch/ using savefig() — they appear in your local ~/julia-scratch/.\n\n' +
  'Pre-installed packages (do NOT call install_julia_package for these):\n' +
  '  Core:      DataFrames, CSV, JSON3, JuMP, HiGHS, StatsBase, Distributions,\n' +
  '             CairoMakie, Turing, Revise, PackageCompiler, DaemonMode\n' +
  '  Debugging: JET, Cthulhu, Infiltrator\n' +
  'Julia standard library (always available): LinearAlgebra, Statistics, Random, Dates, Printf, Base.\n\n' +
  'DEBUGGING GUIDE — use these tools proactively when problems arise:\n\n' +
  '• JET (@report_call / @report_opt) — static analysis BEFORE running questionable code.\n' +
  '  Prefer the dedicated analyze_julia_code tool. Or inline:\n' +
  '    using JET\n' +
  '    @report_call myf(arg1, arg2)   # catches MethodError, UndefVarError, etc. at compile time\n' +
  '    @report_opt  myf(arg1, arg2)   # finds type instabilities and runtime dispatch\n' +
  '  Trigger: MethodError, Union return types, "why is this slow?"\n\n' +
  '• Infiltrator (@exfiltrate) — inspect local variables mid-function without a REPL.\n' +
  '    using Infiltrator\n' +
  '    function myf(x)\n' +
  '        y = transform(x)\n' +
  '        @exfiltrate          # captures all locals → Infiltrator.store\n' +
  '        return y\n' +
  '    end\n' +
  '    myf(input)               # run the function\n' +
  '    Infiltrator.store.x      # access captured variable by name\n' +
  '    Infiltrator.store.y\n' +
  '  Trigger: wrong output, logic errors, need to see intermediate state inside a function.\n\n' +
  '• Cthulhu (@descend_code_typed) — deep non-interactive type-inference dump.\n' +
  '    using Cthulhu\n' +
  '    @descend_code_typed myf(arg1)  # prints fully inferred, annotated IR\n' +
  '  Trigger: mysterious type inference failures, unexpected specializations, subtle Union proliferation.',
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
  'Install a Julia package into the sandbox. Requires approval. ' +
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
  'analyze_julia_code',
  'Statically analyze a Julia function call with JET.jl, catching type errors and ' +
  'performance issues at compile time — before any code actually runs.\n\n' +
  'Returns two reports:\n' +
  '  • @report_call — type/method errors: MethodError, UndefVarError, wrong argument types\n' +
  '  • @report_opt  — performance issues: type instabilities, runtime dispatch, excessive allocations\n\n' +
  'WHEN TO USE THIS TOOL (prefer it over inline JET usage):\n' +
  '  • Before executing a newly-written function that manipulates types non-trivially\n' +
  '  • After a MethodError or UndefVarError to understand the root cause statically\n' +
  '  • When code is unexpectedly slow and you suspect type instability\n' +
  '  • Any time you want compile-time certainty before a long or side-effectful computation\n\n' +
  'NOTE: JET traces through a concrete call, so setup_code must define the function(s) ' +
  'and call_expression must be a single concrete call with representative argument types.',
  {
    setup_code: z.string().describe(
      'Julia code that defines the functions and types to analyze. ' +
      'Do not include `using JET` — it is added automatically. ' +
      'Example: "function add(x::Int, y) x + y end"',
    ),
    call_expression: z.string().describe(
      'A single Julia call expression with concrete argument values or types. ' +
      'Example: "add(1, 2.0)"',
    ),
    timeout_seconds: z
      .number().int().min(1).max(120).optional().default(60)
      .describe('Timeout in seconds (default 60). JET can be slow on first use due to precompilation.'),
  },
  async ({ setup_code, call_expression, timeout_seconds }) => {
    await julia.ensureReady();

    // Step 1: define the functions in their own world so JET can find them.
    // Julia 1.12 enforces strict world-age semantics: a function defined and
    // immediately passed to JET in the same include_string call is invisible
    // to JET's method lookup. Splitting into two calls fixes this.
    const setupResult = await julia.executeCode(
      `using JET\n${setup_code}`,
      timeout_seconds,
    );
    if (setupResult.error) {
      return {
        content: [{ type: 'text', text: `Setup failed:\n${setupResult.error}` }],
        isError: true,
      };
    }

    // Step 2: run both JET reports against the now-visible methods.
    const analysisCode =
      `println("=" ^ 60)\n` +
      `println("JET @report_call — type / method errors")\n` +
      `println("=" ^ 60)\n` +
      `@report_call ${call_expression}\n\n` +
      `println()\n` +
      `println("=" ^ 60)\n` +
      `println("JET @report_opt — performance / type instability")\n` +
      `println("=" ^ 60)\n` +
      `@report_opt ${call_expression}\n`;

    const result = await julia.executeCode(analysisCode, timeout_seconds);

    const parts: string[] = [];
    if (setupResult.stdout) parts.push(`setup stdout:\n${setupResult.stdout}`);
    if (result.stdout)      parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr)      parts.push(`stderr:\n${result.stderr}`);
    if (result.result)      parts.push(`result: ${result.result}`);
    if (result.error)       parts.push(`error:\n${result.error}`);

    return {
      content: [{ type: 'text', text: parts.join('\n\n') || '(no analysis output — JET found nothing to report)' }],
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
