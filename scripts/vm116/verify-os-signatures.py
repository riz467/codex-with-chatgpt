"""Verify acquired public metadata in an isolated GPG home; never retrieves keys."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

root, gpg = Path(sys.argv[1]).resolve(), sys.argv[2]
home = root/(sys.argv[3] if len(sys.argv) == 4 else 'isolated-public-gpg')
if home.exists(): raise ValueError('GPG_HOME_EXISTS')
home.mkdir(mode=0o700)
def gpg_path(path):
    value = path.as_posix()
    if sys.platform == 'win32' and '/Git/' in gpg and len(value) > 2 and value[1] == ':':
        return '/'+value[0].lower()+value[2:]
    return value
common = [gpg, '--batch', '--no-options', '--homedir', gpg_path(home), '--no-auto-key-retrieve', '--status-fd', '1']
meta = root/'os-acquisition/metadata'
ubuntu = meta/'ubuntu-archive-keyring.gpg'
imported = subprocess.run(common+['--import', gpg_path(ubuntu), gpg_path(meta/'microsoft.asc')], capture_output=True, text=True)
if imported.returncode:
    receipt = {'status': 'BLOCKED', 'step': 'PUBLIC_KEY_IMPORT', 'exitCode': imported.returncode, 'stderr': imported.stderr[-2000:]}
    (root/'OS-SIGNATURE-RECEIPT.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))
    sys.exit(2)
allowed_ubuntu = {'F6ECB3762474EDA9D21B7022871920D1991BC93C', '790BC7277767219C42C86F933B4FE6ACC0B21F32'}
allowed_microsoft = {'BC528686B50D79E339D3721CEB3E94ADBE1229CF'}
receipt = {'schema': 1, 'files': {}, 'automaticKeyRetrieval': False, 'installed': False}
for repo in ['noble', 'noble-updates', 'noble-security', 'microsoft-noble']:
    signed = meta/f'{repo}-InRelease'
    result = subprocess.run(common+['--verify', gpg_path(signed)], capture_output=True, text=True)
    statuses = [line.split() for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
    fingerprints = [row[2] for row in statuses]
    allowed = allowed_microsoft if repo.startswith('microsoft') else allowed_ubuntu
    primary = [row[-1] for row in statuses]
    valid = result.returncode == 0 and bool(statuses) and all(f in allowed or p in allowed for f,p in zip(fingerprints,primary))
    package = meta/(f'{repo}-Packages.gz' if repo.startswith('microsoft') else f'{repo}-Packages.xz')
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    expected_path = 'main/binary-amd64/'+package.name.split('-')[-1]
    # Signature validation alone is not the package-index chain: also bind its SHA and size.
    checksum_match = any(line.split() == [digest, str(package.stat().st_size), expected_path] for line in signed.read_text().splitlines())
    receipt['files'][repo] = {'exitCode': result.returncode, 'signers': fingerprints, 'primarySigners': primary, 'signaturePinMatch': valid,
        'indexSha256': digest, 'signedIndexChecksumMatch': checksum_match, 'status': 'PASS' if valid and checksum_match else 'BLOCKED'}
image = root/'os-acquisition/image'
result = subprocess.run(common+['--verify', gpg_path(image/'SHA256SUMS.gpg'), gpg_path(image/'SHA256SUMS')], capture_output=True, text=True)
statuses = [line.split() for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
receipt['cloudImage'] = {'exitCode': result.returncode, 'signers': [row[2] for row in statuses],
    'status': 'BLOCKED', 'reason': 'Cloud image builder key is not independently pinned in this campaign; do not trust a downloaded key automatically'}
receipt['metadataVerified'] = all(value['status'] == 'PASS' for value in receipt['files'].values())
receipt['status'] = 'PARTIAL_METADATA_VERIFIED_IMAGE_BLOCKED' if receipt['metadataVerified'] else 'BLOCKED'
(root/'OS-SIGNATURE-RECEIPT.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt, indent=2))
sys.exit(0 if receipt['metadataVerified'] else 2)
