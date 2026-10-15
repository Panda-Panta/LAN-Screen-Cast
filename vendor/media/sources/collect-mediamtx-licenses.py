"""Collect original notices from modules actually embedded in pinned MediaMTX.

The official module ZIP is checked against the Go h1 value embedded in the
verified executable before any license file is copied. Nothing is executed.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
import re
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


def embedded_modules(binary: Path) -> list[dict]:
    data = binary.read_bytes()
    offset = data.find(b"path\tgithub.com/bluenviron/mediamtx\n")
    if offset < 0:
        raise ValueError("MediaMTX module build information is absent")
    result = []
    for raw_line in data[offset:offset + 65536].split(b"\n"):
        if raw_line.startswith(b"dep\t"):
            parts = raw_line.decode("ascii").split("\t")
            if len(parts) != 4 or not parts[3].startswith("h1:"):
                raise ValueError("Unexpected embedded Go module entry")
            result.append({"module": parts[1], "version": parts[2], "goH1": parts[3]})
    if not result:
        raise ValueError("MediaMTX dependencies are absent")
    return result


def escape_go(value: str) -> str:
    return "".join("!" + char.lower() if "A" <= char <= "Z" else char for char in value)


def module_h1(archive: zipfile.ZipFile) -> str:
    outer_hash = hashlib.sha256()
    for entry in sorted(archive.infolist(), key=lambda item: item.filename):
        if entry.is_dir():
            continue
        filename = entry.filename
        if "\n" in filename or ".." in PurePosixPath(filename).parts:
            raise ValueError("Unsafe Go module filename")
        file_hash = hashlib.sha256(archive.read(entry)).hexdigest()
        outer_hash.update(f"{file_hash}  {filename}\n".encode("utf-8"))
    return "h1:" + base64.b64encode(outer_hash.digest()).decode("ascii")


def download_verified(item: dict, cache: Path, destination: Path, offline: bool) -> dict:
    module = item["module"]
    version = item["version"]
    url = f"https://proxy.golang.org/{escape_go(module)}/@v/{escape_go(version)}.zip"
    name = re.sub(r"[^a-zA-Z0-9_.-]", "_", f"{module}@{version}") + ".zip"
    path = cache / name
    if path.is_file():
        archive_bytes = path.read_bytes()
    else:
        if offline:
            raise FileNotFoundError(f"Offline module cache is missing: {name}")
        request = urllib.request.Request(url, headers={"User-Agent": "LAN-Screen-Cast dependency collector"})
        with urllib.request.urlopen(request, timeout=30) as response:
            archive_bytes = response.read(64 * 1024 * 1024 + 1)
        if len(archive_bytes) > 64 * 1024 * 1024:
            raise ValueError(f"Module archive is too large: {module}")
    archive_sha = hashlib.sha256(archive_bytes).hexdigest()
    if item.get("archiveSha256") and archive_sha != item["archiveSha256"]:
        raise ValueError(f"Module ZIP SHA256 mismatch: {module}")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        if module_h1(archive) != item["goH1"]:
            raise ValueError(f"Module Go h1 mismatch: {module}")
        prefix = f"{module}@{version}/"
        notices = []
        component = re.sub(r"[^a-zA-Z0-9_.-]", "_", f"{module}@{version}")
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.startswith(prefix):
                continue
            relative = PurePosixPath(entry.filename[len(prefix):])
            # Retain nested notices too: crypto and protocol packages include
            # separately credited implementations under their source folders.
            if not re.match(r"(?i)^(LICENSE|COPYING|NOTICE|PATENTS|AUTHORS)(?:[._-].*)?$", relative.name):
                continue
            if ".." in relative.parts or entry.file_size > 512 * 1024:
                raise ValueError(f"Unsafe license entry: {entry.filename}")
            target = destination / component / Path(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
            notices.append((PurePosixPath("licenses/mediamtx-modules") / component / relative).as_posix())
        if not notices:
            # Some old Go forks retain the Go Authors / BSD notice only in
            # source headers, without a separate top-level LICENSE. Preserve
            # their entire original module instead of inventing a notice.
            source_target = destination.parent.parent / "sources" / "go-header-notices" / name
            source_target.parent.mkdir(parents=True, exist_ok=True)
            source_target.write_bytes(archive_bytes)
            notices.append((PurePosixPath("sources/go-header-notices") / name).as_posix())
    if not path.exists():
        path.write_bytes(archive_bytes)
    return {**item, "sourceUrl": url, "archiveSha256": archive_sha,
            "archiveSize": len(archive_bytes), "notices": sorted(notices)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--freeze", action="store_true",
                        help="Create first inventory from the trusted executable")
    args = parser.parse_args()
    root = args.media_root.resolve()
    inventory_path = root / "licenses" / "mediamtx-dependencies.json"
    actual = embedded_modules(root / "bin" / "mediamtx.exe")
    if args.freeze:
        modules = actual
    else:
        modules = json.loads(inventory_path.read_text(encoding="utf-8"))["modules"]
        expected = [{key: item[key] for key in ("module", "version", "goH1")} for item in modules]
        if expected != actual:
            raise ValueError("MediaMTX module inventory differs from the trusted executable")
    args.cache.mkdir(parents=True, exist_ok=True)
    destination = root / "licenses" / "mediamtx-modules"
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        output = list(pool.map(lambda item: download_verified(item, args.cache, destination, args.offline), modules))
    inventory = {"schemaVersion": 1, "binary": "bin/mediamtx.exe", "verification": "embedded Go h1 + ZIP SHA256",
                 "modules": output}
    if args.freeze:
        inventory_path.write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    elif output != modules:
        raise ValueError("Recreated notices differ from the fixed inventory")
    print(f"Verified original notices for {len(output)} embedded Go modules")


if __name__ == "__main__":
    main()
