"""Read-only offline runtime verifier; trusted separately from the archive."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath

BASE = "456eadfc2c12703ad998e009b12d9cb7010ec245"

def require(condition, reason):
    if not condition: raise AssertionError(reason)

def verify(root, digest):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink() and not root.is_junction(), 'ROOT_ALIAS')
    raw = (root / "RUNTIME-MANIFEST.json").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == digest, "MANIFEST_SHA")
    manifest = json.loads(raw)
    require(manifest["schema"] == 1 and manifest["baselineCommit"] == BASE, "BASELINE")
    require(manifest["scope"] == "health-only-staging", "SCOPE")
    require(manifest["node"] == "24.16.0", "NODE")
    require(manifest["dispatch"] == "CLOSED" and manifest["authority"] == "NONE", "AUTHORITY")
    expected = {"RUNTIME-MANIFEST.json"}
    folded = set()
    for item in manifest["files"]:
        name = item["path"]
        rel = PurePosixPath(name)
        require(not rel.is_absolute() and all(p not in ("..", ".") for p in rel.parts), "PATH")
        require("\\" not in name and ":" not in name and str(rel) == name, "PATH")
        require(name.casefold() not in folded and name not in expected, "DUPLICATE")
        folded.add(name.casefold())
        expected.add(name)
        file = root.joinpath(*rel.parts)
        require(file.is_file() and not file.is_symlink(), "FILE_TYPE")
        data = file.read_bytes()
        require(len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"], name)
        require(item["mode"] == "0644", "MODE")
    actual = set()
    for file in root.rglob("*"):
        require(not file.is_symlink() and not file.is_junction(), "ALIAS")
        if file.is_file():
            actual.add(file.relative_to(root).as_posix())
        else:
            require(file.is_dir(), "SPECIAL_FILE")
    require(actual == expected, "INVENTORY")
    return {"status": "PASS", "files": len(expected)-1, "baselineCommit": BASE, "sourceCommit": manifest["sourceCommit"]}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.manifest_sha256)))
