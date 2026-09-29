"""Download the public FormalASR checkpoint into Amadeus' local model directory."""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=("1.7B", "0.6B"), default="1.7B")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    from huggingface_hub import snapshot_download

    repo = f"TaurenMountain/FormalASR-{args.model}"
    models_dir = Path(__file__).resolve().parents[1] / "backend" / "models"
    target = args.output_dir or (
        models_dir / "FormalASR-1.7B" if args.model == "1.7B"
        else models_dir / "formalasr" / repo
    )
    snapshot_download(
        repo_id=repo,
        local_dir=str(target),
        allow_patterns=["*.json", "*.jinja", "*.txt", "*.safetensors", "README.md", "LICENSE*"],
        max_workers=4,
    )
    print(f"Downloaded {repo} to {target.resolve()}")


if __name__ == "__main__":
    main()
