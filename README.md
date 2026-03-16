# julia-mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives LLM clients access to a stateful Julia execution environment running in Docker.

## How it works

The TypeScript MCP server manages two Docker containers:

- **`julia-mcp-sandbox`** — persistent execution container, bridge network, exposes Julia REPL on TCP port 2625
- **`julia-mcp-installer`** — ephemeral sidecar with network access, used exclusively for `Pkg.add()`

Both containers share a `julia-depot` named volume so packages installed via the sidecar are immediately available in the execution container without a restart.

```
LLM client
    │  (MCP / stdio)
    ▼
julia-mcp-server (Node.js)
    │  (TCP 127.0.0.1:2625)
    ▼
julia-mcp-sandbox container   ◄──── julia-depot volume ◄──── julia-mcp-installer (on demand)
```

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Docker](https://www.docker.com) (Desktop or Engine) running

## Setup

```bash
npm install
npm run build
```

Docker images are built automatically on first use. This takes several minutes the first time as Julia packages are precompiled into the image.

## MCP tools

| Tool | Description |
|------|-------------|
| `run_julia_code` | Execute Julia code in the persistent sandbox. State (variables, functions, loaded modules) persists across calls within the same session. |
| `install_julia_package` | Install a package via the network-enabled sidecar. Available immediately after install without resetting the session. |
| `reset_julia_session` | Restart the execution container, clearing all session state. Previously installed packages survive. |

### Pre-installed packages

The sandbox image ships with these packages precompiled:

`DataFrames`, `CSV`, `JSON3`, `JuMP`, `HiGHS`, `StatsBase`, `Distributions`, `CairoMakie`, `Turing`, `Revise`, `PackageCompiler`, `DaemonMode`

Julia standard library is always available: `LinearAlgebra`, `Statistics`, `Random`, `Dates`, `Printf`, `Base`.

### Plots / file output

Plots and other files written to `/home/julia_agent/scratch/` inside the container are mapped to `~/julia-scratch/` on the host. Override the host path with the `JULIA_SCRATCH_PATH` environment variable.

```julia
using CairoMakie
fig = Figure()
# ... build plot ...
save("/home/julia_agent/scratch/plot.png", fig)
```

## Configuring with Claude Code

Add to your MCP settings (e.g. `~/.claude/mcp_settings.json`):

```json
{
  "mcpServers": {
    "julia": {
      "command": "node",
      "args": ["/path/to/julia-mcp-server/dist/index.js"]
    }
  }
}
```

## Security

- The execution container runs on Docker's default bridge network, allowing outbound internet access during code execution.
- A per-session random UUID auth token is generated at startup and required on every request to the Julia TCP server, preventing other local processes from submitting code.
- All Docker CLI calls use array arguments via `execa` (no shell interpolation), preventing command injection.
- Package names are validated against a strict regex (`^[A-Za-z][A-Za-z0-9_]*$`) before being passed to `Pkg.add()`.
- Resource limits: 4 GB RAM, 2 CPUs per execution container.
- Output is capped at 10 MB per response.

## Resource limits

| Limit | Value |
|-------|-------|
| Memory | 4 GB |
| CPUs | 2.0 |
| Execution timeout | 1–300 seconds (default 30 s) |
| Max response size | 10 MB |

## Project structure

```
├── src/
│   ├── index.ts            # MCP server — tool definitions and startup
│   └── julia-runtime.ts    # Docker lifecycle, TCP communication
├── server.jl               # Julia TCP server (runs inside the container)
├── Dockerfile              # Execution container (bridge network, precompiled packages)
├── Dockerfile.installer    # Installer sidecar (network-enabled, no server)
├── entrypoint.sh           # Seeds julia-depot volume on first container start
└── tsconfig.json
```

## Development

```bash
npm run dev   # tsc --watch
```
