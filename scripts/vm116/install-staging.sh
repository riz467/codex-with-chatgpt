#!/bin/bash
# Human-approved bounded root execution only. This file grants no remote admin access.
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == ai-control-116 ]] || exit 10
[[ $# == 4 ]] || { echo 'Usage: install-staging.sh RUNTIME_DIR MANIFEST_SHA VERIFIER_PATH APPROVAL_ID'; exit 11; }
runtime=$(realpath -e "$1"); digest=$2; verifier=$(realpath -e "$3"); approval=$4
[[ $digest =~ ^[0-9a-f]{64}$ && $approval =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || exit 12
# Approval ID is an audit reference, NOT an authorization token. Independent approval is mandatory.
python3 -I -B "$verifier" "$runtime" --manifest-sha256 "$digest"
[[ $(/opt/node-v24.16.0/bin/node --version) == v24.16.0 ]] || exit 13
[[ -x /opt/node-v24.16.0/bin/node && ! -L /opt/node-v24.16.0/bin/node ]] || exit 14
[[ $(awk '/MemAvailable/ {print $2}' /proc/meminfo) -ge 1048576 ]] || exit 15
[[ $(df -Pk /srv | awk 'NR==2 {print $4}') -ge 2097152 ]] || exit 16
dest=/srv/ai-orchestration/codex-with-chatgpt
[[ ! -e $dest && ! -L $dest && ! -e /var/lib/ai-control-staging ]] || exit 17
! getent passwd ai-control-staging >/dev/null || exit 18
! getent group ai-control-staging >/dev/null || exit 18
for role in gateway dashboard; do
  [[ ! -e /etc/systemd/system/ai-linux-$role-staging.service ]] || exit 19
done
! ss -lntH | grep -Eq ':(48767|48768)[[:space:]]' || exit 20
systemctl is-active --quiet ai-control-bridge.service
systemctl is-active --quiet ai-control-cloudflared.service
for parent in /srv /srv/ai-orchestration /var/lib; do
  if [[ -e $parent ]]; then
    [[ ! -L $parent && $(stat -c %u "$parent") == 0 ]] || exit 21
    [[ $(find "$parent" -maxdepth 0 -perm /022 -print | wc -l) == 0 ]] || exit 21
  fi
done
echo "PRE PASS approval=$approval manifest=$digest"
trap 'echo "EXEC FAILED: preserve partial state, STOP; use separately approved rollback" >&2' ERR
useradd --system --user-group --home-dir /var/lib/ai-control-staging --shell /usr/sbin/nologin ai-control-staging
install -d -m 0755 -o root -g root /srv/ai-orchestration "$dest"
cp -R --no-preserve=ownership "$runtime/." "$dest/"
chown -R root:root "$dest"
find "$dest" -type d -exec chmod 0755 {} +
find "$dest" -type f -exec chmod 0644 {} +
install -d -m 0700 -o ai-control-staging -g ai-control-staging /var/lib/ai-control-staging
python3 -I -B "$verifier" "$dest" --manifest-sha256 "$digest"
for role in gateway dashboard; do
  install -m 0644 -o root -g root "$dest/scripts/systemd/ai-linux-$role-staging.service" /etc/systemd/system/
done
systemd-analyze verify /etc/systemd/system/ai-linux-{gateway,dashboard}-staging.service
systemctl daemon-reload
systemctl enable --now ai-linux-gateway-staging.service ai-linux-dashboard-staging.service
echo 'EXEC complete; POST health/refusal/restart/admin/Bridge/Tunnel checks still required'
