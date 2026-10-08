"""Committed source ZIP handoff; Python standard library, no checkout or dependency access."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import zipfile

MANIFEST = "SOURCE-MANIFEST.json"
ROOT_FILES = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
              "vitest.config.ts", "LICENSE", "README.md"}
DOCS = {"docs/linux-portability-phase1.md", "docs/linux-portability-phase15.md",
        "docs/linux-portability-phase16.md", "docs/linux-fixture-handoff.md"}
EXTENSIONS = {".ts", ".mts", ".js", ".mjs", ".ps1", ".sh", ".cmd", ".vbs",
              ".json", ".md", ".html", ".css", ".py"}
FORBIDDEN = {"node_modules", "home", "secrets", "runtime", "ledger", "sessions",
             ".git", ".tooling", "dist", "__pycache__"}
MAX_BYTES = 128 * 1024 * 1024
SECRET = re.compile(rb"-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----\s+[A-Za-z0-9+/]{64}|(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{30,})")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    require(isinstance(name, str) and len(name) <= 240, "invalid path")
    parts = name.split("/")
    require(all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) and part not in {".", ".."}
                and not part.endswith((".", " ")) for part in parts), "unsafe path: " + name)
    require(not any(part.lower() in FORBIDDEN or part.startswith(".") or
                    re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", part)
                    for part in parts), "excluded path: " + name)
    return name


def allowed(name):
    return name in ROOT_FILES | DOCS or (name.split("/")[0] in {"src", "tests", "scripts"}
                                         and Path(name).suffix in EXTENSIONS)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(["git", "--no-replace-objects", "-C", str(repo), *args])


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def validate(data, commit):
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "full commit SHA required")
    require(len(data) <= MAX_BYTES, "archive too large")
    files = {}
    modes = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) <= 10000 and sum(e.file_size for e in entries) <= MAX_BYTES,
                "archive expansion limit")
        seen = set()
        paths = {}
        for entry in entries:
            name = safe_name(entry.filename)
            require(name.casefold() not in seen, "duplicate/case-colliding path")
            seen.add(name.casefold())
            parts = name.split("/")
            for index in range(1, len(parts) + 1):
                prefix = "/".join(parts[:index])
                identity = (prefix, index == len(parts))
                require(paths.get(prefix.casefold(), identity) == identity,
                        "ancestor case/file-directory collision")
                paths[prefix.casefold()] = identity
            mode = entry.external_attr >> 16
            require(entry.create_system == 3 and stat.S_ISREG(mode) and
                    stat.S_IMODE(mode) in {0o644, 0o755} and not entry.is_dir(),
                    "non-regular file or unsafe mode: " + name)
            require(not entry.flag_bits & 1, "encrypted entry")
            require(name == MANIFEST or allowed(name), "outside source allowlist: " + name)
            files[name] = archive.read(entry)
            modes[name] = stat.S_IMODE(mode)
    require(MANIFEST in files, "missing manifest")
    manifest = json.loads(files.pop(MANIFEST), object_pairs_hook=unique_object)
    require(manifest.get("schema") == 1 and manifest.get("commit") == commit,
            "manifest schema/commit mismatch")
    records = manifest.get("files")
    require(isinstance(records, dict) and set(records) == set(files), "missing/extra files")
    require(ROOT_FILES | DOCS <= set(files), "missing required source inputs")
    for name, content in files.items():
        record = records[name]
        require(record == {"sha256": sha(content), "size": len(content), "mode": modes[name]},
                "hash/size/mode mismatch: " + name)
    return manifest, files, modes


def build(repo, commit, output):
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "full commit SHA required")
    require(git(repo, "rev-parse", "--verify", commit + "^{commit}").decode().strip() == commit,
            "commit mismatch")
    files = {}
    modes = {}
    for row in git(repo, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not row:
            continue
        metadata, raw_name = row.split(b"\t", 1)
        name = raw_name.decode("utf-8")
        if not allowed(name):
            continue
        safe_name(name)
        mode, kind, blob = metadata.decode().split()
        require(kind == "blob" and mode in {"100644", "100755"}, "tracked link/non-file: " + name)
        content = git(repo, "cat-file", "blob", blob)
        # Fail closed on common private-key/credential forms; review remains necessary for novel secrets.
        require(not SECRET.search(content),
                "possible secret: " + name)
        files[name] = content
        modes[name] = int(mode, 8) & 0o777
    package = json.loads(files["package.json"])
    manifest = {"schema": 1, "commit": commit, "source_status": "SOURCE_READY",
                "offline_status": "BLOCKED", "dependency_closure": "NOT_INCLUDED_NOT_VERIFIED",
                "package_manager": package["packageManager"], "node_engines": package["engines"],
                "dependencies": package["dependencies"], "dev_dependencies": package["devDependencies"],
                "files": {name: {"sha256": sha(content), "size": len(content), "mode": modes[name]}
                          for name, content in sorted(files.items())}}
    files[MANIFEST] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    modes[MANIFEST] = 0o644
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | modes[name]) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content)
    data = buffer.getvalue()
    validate(data, commit)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    name = "linux-fixture-source-" + commit
    with (output / (name + ".zip")).open("xb") as handle:
        handle.write(data)
    (output / (name + ".sha256")).write_text(sha(data) + "  " + name + ".zip\n", encoding="utf-8")
    (output / (name + ".manifest.json")).write_bytes(files[MANIFEST])
    return {"archive": str(output / (name + ".zip")), "sha256": sha(data), "commit": commit,
            "source_status": "SOURCE_READY", "offline_status": "BLOCKED", "files": len(files) - 1}


def check(archive, commit, expected_sha, destination=None):
    require(re.fullmatch(r"[0-9a-f]{64}", expected_sha), "trusted archive SHA-256 required")
    with Path(archive).open("rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    require(sha(data) == expected_sha, "archive SHA-256 mismatch")
    manifest, files, modes = validate(data, commit)
    if destination is not None:
        destination = Path(destination).absolute()
        for parent in [destination, *destination.parents]:
            require(not parent.is_symlink() and not os.path.isjunction(parent), "destination link/junction")
        require(destination.parent.is_dir(), "destination parent must exist")
        destination.mkdir(mode=0o700)  # Existing targets are never merged or overwritten.
        try:
            for name, content in files.items():
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as handle:
                    handle.write(content)
                target.chmod(modes[name])
            (destination / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        except BaseException:
            shutil.rmtree(destination)
            raise
    return {"commit": commit, "files": len(files), "source_status": "SOURCE_READY",
            "offline_status": "BLOCKED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pack = commands.add_parser("build")
    pack.add_argument("--repo", default=".")
    pack.add_argument("--commit", required=True)
    pack.add_argument("--output", required=True)
    for verb in ("verify", "extract"):
        command = commands.add_parser(verb)
        command.add_argument("--archive", required=True)
        command.add_argument("--commit", required=True)
        command.add_argument("--sha256", required=True)
        if verb == "extract":
            command.add_argument("--destination", required=True)
    args = parser.parse_args()
    try:
        result = build(args.repo, args.commit, args.output) if args.command == "build" else check(
            args.archive, args.commit, args.sha256, getattr(args, "destination", None))
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        parser.exit(1, "BUNDLE_REJECTED: " + str(error) + "\n")


if __name__ == "__main__":
    main()
