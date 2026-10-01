#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH
[ "$#" -eq 0 ] || exit 1
exec /usr/bin/node --jitless /var/cache/ct701-typed-action-finalizer/package/runtime/typed-action-finalizer/deployment-cli.js rollback
