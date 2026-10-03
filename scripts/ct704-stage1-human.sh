#!/bin/bash
# Human-admin only, on pve5. Argument is the reviewed local package tar file.
# No pct set/start/stop, host package install, ACL, network or other guest operation.
set -euo pipefail
test "$(hostname -s)" = pve5
test "$#" = 1 && test -f "$1"
test "$(pct status 704)" = 'status: running'
before=$(pct config 704)
export CT704_CONFIG="$before"
python3 -I - <<'CHECK'
import os
c = dict(line.split(': ', 1) for line in os.environ['CT704_CONFIG'].splitlines() if ': ' in line)
assert c.get('unprivileged') == '1', 'unprivileged required'
features = dict(item.split('=', 1) for item in c.get('features', '').split(',') if item)
assert features.get('nesting', '0') == '0', 'nesting forbidden'
assert features.get('keyctl', '0') == '0', 'keyctl forbidden'
assert not any(k.startswith(('mp', 'dev', 'lxc.apparmor', 'lxc.seccomp', 'lxc.mount', 'lxc.cgroup')) for k in c), 'unexpected mount/device/security override: STOP for review'
assert '192.168.0.53/24' in c.get('net0', ''), 'CT704 identity/address mismatch'
print('CT704_CONFIG_BOUNDARY=PASS')
CHECK
unset CT704_CONFIG
verify_config() {
  test "$(pct config 704)" = "$before" || { echo 'CT704_CONFIG_DRIFT=FAIL' >&2; return 1; }
}
trap verify_config EXIT
guest_name=$(pct exec 704 -- hostname -s)
expected_name=$(printf '%s\n' "$before" | sed -n 's/^hostname: //p')
test "$guest_name" = "$expected_name"
echo "Target: CT704 / pve5 / $guest_name"
# Empty fresh destination only. Tar was produced from the explicit file inventory.
pct exec 704 -- mkdir /opt/rc02-stage1
pct exec 704 -- tar -xf - -C /opt/rc02-stage1 --no-same-owner < "$1"
pct exec 704 -- env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash /opt/rc02-stage1/scripts/ct704-stage1-guest.sh
verify_config
echo 'CT704_HOST_BOUNDARY=PASS; HUMAN_AUTHORITY_REVIEW_STILL_REQUIRED'
