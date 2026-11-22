#!/bin/sh
set -eu

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: Node.js / npx is required to inject plugins without installing a global CLI." >&2
  echo "Install Node.js (>=18) from https://nodejs.org/ and re-run." >&2
  exit 1
fi

exec npx -y dsh-agent-cleaner setup --yes "$@"
