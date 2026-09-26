#!/bin/sh
set -eu
# Run as CT root with a built runtime artifact. Never run on AI-Workspace.
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 2 ]; then
  echo 'Usage: install.sh /path/to/ai-approver-package <fixed-host>.<tailnet>.ts.net (CT root only)' >&2
  exit 2
fi
artifact=$1
host=$2
case "$host" in
  *[!a-z0-9.-]*|.*|*..*) echo 'Invalid host' >&2; exit 2 ;;
esac
printf '%s' "$host" | grep -Eq '^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$' || { echo 'A full ts.net hostname is required' >&2; exit 2; }
[ -f "$artifact/package-lock.json" ] && [ -d "$artifact/runtime/approver-service" ] || { echo 'Invalid artifact' >&2; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo 'Node >=24 required' >&2; exit 2; }
if ! id ai-approver >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/ai-approver --shell /usr/sbin/nologin ai-approver
fi
install -d -m 0750 -o ai-approver -g ai-approver /var/lib/ai-approver
install -d -m 0755 -o root -g root /etc/ai-approver /opt/ai-approver /opt/ai-approver/runtime /opt/ai-approver/runtime/approver-service /opt/ai-approver/runtime/approver-service/public /opt/ai-approver/runtime/human-approval
install -m 0644 -o root -g root "$artifact/package.json" "$artifact/package-lock.json" /opt/ai-approver/
for file in "$artifact"/runtime/approver-service/*.js; do install -m 0644 -o root -g root "$file" /opt/ai-approver/runtime/approver-service/; done
for file in "$artifact"/runtime/approver-service/public/*; do install -m 0644 -o root -g root "$file" /opt/ai-approver/runtime/approver-service/public/; done
install -m 0644 -o root -g root "$artifact/runtime/human-approval/contract.js" /opt/ai-approver/runtime/human-approval/
cd /opt/ai-approver
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [ ! -e /etc/ai-approver/config.json ]; then
  printf '{"rp_id":"%s","origin":"https://%s","key_id":"approver-v1","db_path":"/var/lib/ai-approver/approver.db","signing_key_path":"/var/lib/ai-approver/signing.key","port":48768}\n' "$host" "$host" > /etc/ai-approver/config.json
  chmod 0644 /etc/ai-approver/config.json
fi
install -m 0644 -o root -g root "$artifact/ai-approver.service" /etc/systemd/system/ai-approver.service
systemctl daemon-reload
echo 'Installed files only. As CT admin: runuser -u ai-approver -- node /opt/ai-approver/runtime/approver-service/cli.js init; then systemctl enable --now ai-approver'
