"""Bounded trusted extraction: validate every byte/path before creating a new destination."""
import hashlib
import importlib.util
import json
import sys
import tarfile
from pathlib import Path, PurePosixPath

def require(condition, reason):
    if not condition: raise ValueError(reason)

def extract(archive, archive_sha, manifest_sha, destination):
    archive, destination = Path(archive), Path(destination)
    require(archive.stat().st_size <= 32*1024*1024, 'ARCHIVE_LIMIT')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == archive_sha, 'ARCHIVE_SHA')
    require(not destination.exists() and not destination.is_symlink() and not destination.is_junction(), 'DEST_EXISTS')
    for parent in destination.absolute().parents:
        require(parent.is_dir() and not parent.is_symlink() and not parent.is_junction(), 'PARENT_ALIAS')
    blobs = {}
    folded = set()
    with tarfile.open(archive, 'r:') as tar:
        total = 0
        for item in tar:
            name, relative = item.name, PurePosixPath(item.name)
            require(len(blobs) < 5000 and item.isreg() and item.mode == 0o644, 'ENTRY_TYPE_LIMIT')
            require(not relative.is_absolute() and '..' not in relative.parts and str(relative) == name, 'PATH')
            require('\\' not in name and ':' not in name and name.casefold() not in folded, 'PATH_DUPLICATE')
            require(0 <= item.size <= 8*1024*1024, 'FILE_LIMIT')
            total += item.size
            require(total <= 24*1024*1024, 'TOTAL_LIMIT')
            folded.add(name.casefold())
            blobs[name] = tar.extractfile(item).read()
    raw = blobs.get('RUNTIME-MANIFEST.json', b'')
    require(hashlib.sha256(raw).hexdigest() == manifest_sha, 'MANIFEST_SHA')
    manifest = json.loads(raw)
    expected = {'RUNTIME-MANIFEST.json'}
    for item in manifest['files']:
        name = item['path']
        require(name not in expected and name in blobs, 'INVENTORY')
        data = blobs[name]
        require(len(data) == item['bytes'] and hashlib.sha256(data).hexdigest() == item['sha256'], 'FILE_SHA')
        expected.add(name)
    require(set(blobs) == expected, 'INVENTORY')
    # Reject file/parent collisions before any writes.
    for name in blobs:
        require(all(str(parent) not in blobs for parent in PurePosixPath(name).parents if str(parent) != '.'), 'PARENT_FILE')
    destination.mkdir(mode=0o700)
    for name, data in blobs.items():
        target = destination.joinpath(*name.split('/'))
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as file: file.write(data)
        target.chmod(0o644)
    spec = importlib.util.spec_from_file_location('verifier', Path(__file__).with_name('verify-runtime.py'))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    return verifier.verify(destination, manifest_sha)

if __name__ == '__main__':
    require(len(sys.argv) == 5, 'Usage: extract-runtime.py ARCHIVE ARCHIVE_SHA MANIFEST_SHA NEW_DEST')
    print(json.dumps(extract(*sys.argv[1:])))
