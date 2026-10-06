"""The packaged Windows ASR default must resolve to CUDA wheels."""

from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pytest includes tomli on Python 3.10.
    import tomli as tomllib


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_windows_pytorch_lock_has_official_cuda_wheels():
    """Prevent a successful dependency install from restoring CPU-only PyTorch."""
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((PROJECT_ROOT / "uv.lock").read_text(encoding="utf-8"))
    uv = project["tool"]["uv"]
    index = next(index for index in uv["index"] if index["name"] == "pytorch-cu128")
    assert index["explicit"] is True
    assert index["url"] == "https://download.pytorch.org/whl/cu128"

    for name in ("torch", "torchaudio"):
        assert uv["sources"][name] == [{
            "index": "pytorch-cu128", "marker": "sys_platform == 'win32'",
        }]
        package = next(
            item for item in lock["package"]
            if item["name"] == name and item["version"].endswith("+cu128")
        )
        assert package["source"]["registry"] == index["url"]
        assert any(
            "cp312-cp312-win_amd64.whl" in wheel["url"]
            and wheel["hash"].startswith("sha256:")
            for wheel in package["wheels"]
        )
