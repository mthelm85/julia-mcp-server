"""
Julia MCP Execution Server

Listens on TCP port 2625. Each connection receives a JSON request, executes
the Julia code in the persistent Main module (preserving state across calls),
and returns a JSON response with stdout, stderr, result, and error fields.

Protocol:
  Request:  {"code": "<julia source string>", "token": "<auth token>"}
  Response: {"stdout": "...", "stderr": "...", "result": "...", "error": "..."}

Security:
  JULIA_MCP_TOKEN env var — if set, every request must carry a matching token.
  Base.exit_on_sigint(false) — SIGINT throws InterruptException instead of
  exiting the process, enabling TypeScript-side timeouts to interrupt execution.
"""

using Sockets
using JSON3

# SIGINT throws InterruptException rather than killing the server process.
# This allows the TypeScript timeout handler to interrupt stuck executions
# via `docker kill --signal SIGINT`.
Base.exit_on_sigint(false)

const PORT  = 2625
const TOKEN = get(ENV, "JULIA_MCP_TOKEN", "")

function execute_code(code::String)
    result_str = ""
    error_str  = ""

    # Julia 1.12: redirect_stdout/stderr no longer accept IOBuffer.
    # Use OS-level pipe capture instead.
    orig_out = stdout
    orig_err = stderr
    rd_out, wr_out = redirect_stdout()
    rd_err, wr_err = redirect_stderr()

    val = nothing
    try
        val = include_string(Main, code, "julia_mcp_input")
    catch e
        if e isa InterruptException
            error_str = "Execution interrupted (timeout)"
        else
            error_str = sprint(showerror, e, catch_backtrace())
        end
    end

    # Restore streams before reading so further Julia output isn't lost
    flush(stdout)
    flush(stderr)
    redirect_stdout(orig_out)
    redirect_stderr(orig_err)
    close(wr_out)
    close(wr_err)

    stdout_str = read(rd_out, String)
    stderr_str = read(rd_err, String)
    close(rd_out)
    close(rd_err)

    if error_str == "" && val !== nothing && val !== Main
        result_str = repr(val)
    end

    return (
        stdout = stdout_str,
        stderr = stderr_str,
        result = result_str,
        error  = error_str,
    )
end

function handle_connection(conn)
    try
        data = read(conn, String)
        req  = JSON3.read(data)

        # Validate auth token when one is configured
        if TOKEN != "" && get(req, :token, "") != TOKEN
            write(conn, JSON3.write(Dict("stdout" => "", "stderr" => "",
                                         "result" => "", "error" => "Unauthorized")))
            return
        end

        code = String(req[:code])
        resp = execute_code(code)
        write(conn, JSON3.write(resp))
    catch e
        try
            msg = e isa InterruptException ? "Execution interrupted (timeout)" :
                  sprint(showerror, e)
            write(conn, JSON3.write(Dict("stdout" => "", "stderr" => "",
                                         "result" => "", "error" => msg)))
        catch
        end
    finally
        close(conn)
    end
end

server = listen(IPv4(0), PORT)
println("Julia MCP server ready on port $PORT")
flush(stdout)

while true
    local conn
    try
        conn = accept(server)
    catch e
        # SIGINT while blocked on accept — harmless, just continue
        e isa InterruptException && continue
        rethrow()
    end
    @async handle_connection(conn)
end
