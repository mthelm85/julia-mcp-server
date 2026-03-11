# Julia 1.12.5 with Redefinable Structs & Trimming Support
FROM julia:1.12.5-bookworm

# 1. System dependencies for Data Science & Binary Compilation
RUN apt-get update && apt-get install -y \
    build-essential \
    gcc \
    g++ \
    gfortran \
    cmake \
    libxml2 \
    git \
    && rm -rf /var/lib/apt/lists/*

# 2. Set up the agent user and reserve /opt/julia-base for the depot backup
RUN useradd -m -s /bin/bash julia_agent && \
    mkdir -p /opt/julia-base && \
    chown julia_agent:julia_agent /opt/julia-base

USER julia_agent
WORKDIR /home/julia_agent

# 3. Performance & rendering environment
ENV JULIA_NUM_THREADS=auto
ENV JULIA_PKG_PRECOMPILE_AUTO=0
# CairoMakie: suppress GKS display, forces file-based rendering (headless-safe)
ENV GKSwstype=nohook

# 4. Build the "Fat" Environment
# LinearAlgebra is a stdlib — available by default, not installed here
RUN julia -e 'using Pkg; \
    Pkg.add([ \
        "DataFrames", "CSV", "JSON3", \
        "JuMP", "HiGHS", "StatsBase", \
        "CairoMakie", \
        "Revise", "PackageCompiler", \
        "DaemonMode", \
        "Turing", "Distributions" \
    ]); \
    Pkg.precompile()'

# 5. Back up the fully-baked depot to /opt/julia-base.
# At runtime the julia-depot volume is mounted at ~/.julia and starts empty,
# which would shadow these packages. entrypoint.sh seeds the volume from this
# backup on first container start (one-time cost, ~1-3 min).
RUN cp -a /home/julia_agent/.julia/. /opt/julia-base/

# 6. Persistence setup — bridge to host scratch directory
RUN mkdir -p /home/julia_agent/scratch

# 7. Copy the server script and entrypoint
COPY --chown=julia_agent:julia_agent server.jl    /home/julia_agent/server.jl
COPY --chown=julia_agent:julia_agent entrypoint.sh /home/julia_agent/entrypoint.sh
RUN chmod +x /home/julia_agent/entrypoint.sh

# 8. Start via entrypoint (seeds depot if empty, then starts Julia server)
CMD ["/home/julia_agent/entrypoint.sh"]
