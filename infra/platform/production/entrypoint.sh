#!/bin/sh
set -eu
case "${1:-web}" in
  web) exec node --import tsx src/main.ts ;;
  worker) exec node --import tsx src/worker-main.ts ;;
  migrate) exec node --import tsx src/migrate.ts ;;
  operations) exec node --import tsx src/operations-main.ts ;;
  *) printf '%s\n' 'Expected one role: web, worker, migrate or operations.' >&2; exit 64 ;;
esac
