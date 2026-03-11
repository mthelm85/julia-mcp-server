#!/bin/bash
set -e

# Seed the Julia depot volume on first container start.
#
# Problem: the julia-depot named volume is mounted at /home/julia_agent/.julia at
# runtime, shadowing the packages baked into the image at that path. On first start
# the volume is empty, so Julia can't find any packages and server.jl crashes.
#
# Fix: if the volume is empty, copy the baked depot from /opt/julia-base into it.
# This is a one-time cost (~1-3 minutes). All subsequent container starts skip this.
# The installer sidecar also writes to this volume, so user-installed packages
# survive container restarts.

if [ -z "$(ls -A /home/julia_agent/.julia 2>/dev/null)" ]; then
    echo "[julia-mcp] Seeding Julia depot from baked image (first run, ~1-3 min)..."
    cp -a /opt/julia-base/. /home/julia_agent/.julia/
    touch /home/julia_agent/.julia/.seeded
    echo "[julia-mcp] Depot seeded successfully."
fi

exec julia /home/julia_agent/server.jl
