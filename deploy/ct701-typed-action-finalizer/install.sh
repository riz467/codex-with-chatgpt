#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH
case "$#:${1-}" in
  0:) action=install ;;
  1:--dry-run) action=dry-run ;;
  *) echo 'Only --dry-run is accepted' >&2; exit 1 ;;
esac
exec /usr/bin/node --jitless /var/cache/ct701-typed-action-finalizer/package/runtime/typed-action-finalizer/deployment-cli.js "$action"
