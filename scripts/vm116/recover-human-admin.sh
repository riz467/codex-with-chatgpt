#!/bin/bash
# Execute only through a separately approved, time-bounded PVE/QGA root path.
# Human password is deliberately LOCKED; Human public key + Human-only sudo is the managed recovery route.
set -euo pipefail
[[ $(id -u) == 0 && $(hostname) == ai-control-116 ]] || exit 10
[[ $# == 3 ]] || { echo 'Usage: recover-human-admin.sh PUBLIC_KEY_FILE EXPECTED_FINGERPRINT APPROVAL_ID'; exit 11; }
key=$(realpath -e "$1"); fingerprint=$2; approval=$3
[[ $approval =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || exit 12
[[ $(wc -l < "$key") == 1 && $(head -c 12 "$key") == 'ssh-ed25519 ' ]] || exit 13
[[ $(ssh-keygen -lf "$key" -E sha256 | awk '{print $2}') == "$fingerprint" ]] || exit 14
! getent passwd human-admin >/dev/null || exit 15
[[ ! -e /etc/sudoers.d/90-vm116-human-admin && ! -e /etc/ssh/sshd_config.d/00-vm116-human-admin.conf ]] || exit 16
/usr/sbin/sshd -t
echo "PRE PASS approval=$approval publicKey=$fingerprint"
trap 'echo "EXEC FAILED: STOP; do not close original management session" >&2' ERR
useradd --create-home --shell /bin/bash human-admin
passwd -l human-admin
install -d -o human-admin -g human-admin -m 0700 /home/human-admin/.ssh
install -o human-admin -g human-admin -m 0600 "$key" /home/human-admin/.ssh/authorized_keys
printf '%s\n' 'human-admin ALL=(ALL:ALL) NOPASSWD: ALL' >/etc/sudoers.d/90-vm116-human-admin
chmod 0440 /etc/sudoers.d/90-vm116-human-admin
visudo -cf /etc/sudoers.d/90-vm116-human-admin
# OpenSSH uses first value for scalar options. A new first drop-in avoids changing existing files.
printf '%s\n' 'PermitRootLogin no' 'PasswordAuthentication no' 'PubkeyAuthentication yes' 'AllowUsers human-admin workspace' >/etc/ssh/sshd_config.d/00-vm116-human-admin.conf
chmod 0644 /etc/ssh/sshd_config.d/00-vm116-human-admin.conf
/usr/sbin/sshd -t
effective=$(/usr/sbin/sshd -T)
grep -qx 'permitrootlogin no' <<<"$effective"
grep -qx 'passwordauthentication no' <<<"$effective"
grep -q 'allowusers .*human-admin' <<<"$effective"
systemctl reload ssh.service
echo 'EXEC complete. POST independent Human SSH + sudo -n verification REQUIRED before staging installation.'
