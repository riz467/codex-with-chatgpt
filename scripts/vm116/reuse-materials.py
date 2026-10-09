"""Reuse previously acquired public OS/toolchain bytes; no network, no installation."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

archive, output = map(Path, sys.argv[1:])
if output.exists(): raise ValueError('OUTPUT_EXISTS')
output.mkdir(parents=True)
receipt = {'status': 'ACQUIRED_BYTE_VERIFIED_NOT_INSTALLED', 'files': {}, 'signatureGate': 'OS/Microsoft signature verification still required; Node prior VALIDSIG receipt reused'}
with zipfile.ZipFile(archive) as z:
    manifest = json.loads(z.read('MATERIALS-MANIFEST.json'))
    selected = {name: info for name, info in manifest['files'].items() if name.startswith(('toolchain/', 'os-acquisition/'))}
    for name, info in selected.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or '\\' in name: raise ValueError('PATH')
        data = z.read(name)
        digest = hashlib.sha256(data).hexdigest()
        if digest != info['sha256'] or len(data) != info['size']: raise ValueError('SHA')
        dest = output.joinpath(*relative.parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open('xb') as f: f.write(data)
        receipt['files'][name] = dict(sha256=digest, bytes=len(data))
    node = receipt['files']['toolchain/node-v24.16.0-linux-x64.tar.xz']
    if node['sha256'] != 'd804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9': raise ValueError('NODE_PIN')
(output / 'REUSE-RECEIPT.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'status': receipt['status'], 'files': len(receipt['files']), 'bytes': sum(f['bytes'] for f in receipt['files'].values())}))
