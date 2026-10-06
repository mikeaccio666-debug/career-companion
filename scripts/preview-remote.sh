#!/usr/bin/env bash
set -euo pipefail

# A development preview only. Remote services must already listen on loopback.
# Existing localhost listeners cause an explicit failure instead of being killed.
exec ssh -N \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:4321:127.0.0.1:3121 \
  -L 127.0.0.1:4320:127.0.0.1:3120 \
  edaix-dev
