"""Create deterministic regular-file tar. Verify archive SHA separately before extraction."""
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path

root, output = map(Path, sys.argv[1:])
raw = (root/'RUNTIME-MANIFEST.json').read_bytes()
digest = hashlib.sha256(raw).hexdigest()
spec = importlib.util.spec_from_file_location('verifier', Path(__file__).with_name('verify-runtime.py'))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
verifier.verify(root, digest)
if output.exists(): raise ValueError('OUTPUT_EXISTS')
with output.open('xb') as dest:
    with tarfile.open(fileobj=dest, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(['RUNTIME-MANIFEST.json']+[f['path'] for f in json.loads(raw)['files']]):
            data = root.joinpath(*name.split('/')).read_bytes()
            item = tarfile.TarInfo(name)
            item.size = len(data)
            item.mode = 0o644
            item.uid = item.gid = item.mtime = 0
            tar.addfile(item, io.BytesIO(data))
print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'manifestSha256': digest}))
