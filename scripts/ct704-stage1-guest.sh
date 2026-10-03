#!/bin/bash
# Run ONLY through the pve5 human-admin wrapper; KVM guest required.
set -euo pipefail
trap 'echo "RC02_STAGE1=FAIL; STOP; NO_SECURITY_FALLBACK" >&2' ERR
test "$(id -u)" = 0
. /etc/os-release
test "$ID" = debian && test "$VERSION_ID" = 13
test "$(uname -m)" = x86_64
test "$(systemd-detect-virt)" = kvm
cd /opt/rc02-stage1
test ! -e /opt/rc02-sandbox-runtime && test ! -e /opt/rc02-fast-runtime
apt-get update
apt-get install -y --no-install-recommends bubblewrap git ca-certificates wget xz-utils libstdc++6 libgcc-s1 libatomic1
command -v ldd runuser useradd tar sha256sum >/dev/null
dpkg-query -W bubblewrap git libc6 libstdc++6 libgcc-s1 libatomic1
/usr/bin/bwrap --version
node_dir=/opt/node-v26.10.0-linux-x64
test ! -e "$node_dir"
archive=$(mktemp /var/tmp/ct704-node.XXXXXX.tar.xz)
wget --https-only -O "$archive" https://nodejs.org/dist/v26.10.0/node-v26.10.0-linux-x64.tar.xz
echo "ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022  $archive" | sha256sum -c -
tar -xJf "$archive" -C /opt --no-same-owner
rm "$archive"
export PATH="$node_dir/bin:/usr/sbin:/usr/bin:/sbin:/bin"
test "$(node --version)" = v26.10.0
# Acquiring tooling is administrator preparation, never candidate execution.
# Keep the repository manifest/pnpm policies unchanged; use an isolated manifest.
tools=$(mktemp -d /var/tmp/ct704-tools.XXXXXX)
printf '%s\n' '{"private":true,"dependencies":{"vitest":"3.2.7","zod":"3.25.76","typescript":"5.9.3","tsx":"4.23.12"}}' > "$tools/package.json"
touch "$tools/user.npmrc" "$tools/global.npmrc"
env -i PATH="$PATH" HOME="$tools" node "$node_dir/lib/node_modules/npm/bin/npm-cli.js" install \
  --prefix="$tools" --ignore-scripts --bin-links=false --no-audit --no-fund \
  --userconfig="$tools/user.npmrc" --globalconfig="$tools/global.npmrc" --registry=https://registry.npmjs.org
cp -rL "$tools/node_modules" ./node_modules
cp "$tools/package-lock.json" ./stage1-tooling-lock.json
node scripts/ct704-stage1-runtime.mjs
# A dedicated non-login account, no sudo/groups/keys. Do not reuse an existing identity.
! getent passwd rc02-stage1
useradd --system --user-group --home-dir /var/lib/rc02-stage1 --create-home --shell /usr/sbin/nologin rc02-stage1
chmod 700 /var/lib/rc02-stage1
chown -R root:root /opt/rc02-stage1 "$node_dir"
chmod -R go-w /opt/rc02-stage1 "$node_dir"
runuser -u rc02-stage1 -- env -i PATH="$PATH" LANG=C HOME=/var/lib/rc02-stage1 TMPDIR=/var/lib/rc02-stage1 \
  node scripts/ct704-stage1-live.mjs
echo 'RC02_STAGE1_FIXTURES=PASS; AUTHORITY_REVIEW_REQUIRED; PRODUCTION_DISABLED'
