"""Prepare a versioned GLB download manifest locally. Does not upload any assets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse


def make_manifest(asset: Path, version: str, global_url: str, mainland_url: str) -> dict:
    if asset.suffix.lower() != ".glb" or not asset.is_file():
        raise ValueError("Choose the exported runtime GLB file.")
    for value in (global_url, mainland_url):
        if value and (urlparse(value).scheme != "https" or not urlparse(value).hostname):
            raise ValueError("Published download addresses must use HTTPS.")
    digest = hashlib.sha256()
    with asset.open("rb") as stream:
        if stream.read(4) != b"glTF":
            raise ValueError("The file is not a binary glTF model.")
        stream.seek(0)
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "schema_version": 1,
        "id": "aemeath-digital-human",
        "version": version,
        "filename": asset.name,
        "format": "glb",
        "size": asset.stat().st_size,
        "sha256": digest.hexdigest(),
        "urls": {"global": global_url or None, "mainland": mainland_url or None},
        "publication_status": "ready_for_host_configuration" if global_url or mainland_url else "hosting_not_configured",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asset", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--global-url", default="")
    parser.add_argument("--mainland-url", default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = make_manifest(args.asset, args.version, args.global_url, args.mainland_url)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Manifest saved locally: {args.output}")
