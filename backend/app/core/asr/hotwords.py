"""CapsWriter-style offline hotword and regex correction.

The two editable text files intentionally use the familiar CapsWriter syntax:
``target|alias1|alias2~~~black1|black2`` and ``pattern = replacement``.
Files are mtime-checked on every offline request, so external edits take effect
without restarting the backend.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

try:
    from pypinyin import Style, lazy_pinyin
except ImportError:  # exact aliases and rules remain available in minimal installs
    Style = None  # type: ignore[assignment]
    lazy_pinyin = None  # type: ignore[assignment]


@dataclass(frozen=True)
class HotwordEntry:
    target: str
    aliases: tuple[str, ...]
    blacklist: tuple[str, ...]


@dataclass
class HotwordApplyResult:
    text: str
    replacements: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[dict[str, Any]] = field(default_factory=list)


def _data_dir() -> Path:
    configured = os.getenv("ASRAPP_HOTWORDS_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[4] / "data" / "asr" / "hotwords"


def _phonemes(text: str) -> str:
    if lazy_pinyin is None or Style is None:
        return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", text.lower())
    parts = lazy_pinyin(
        text,
        style=Style.NORMAL,
        errors=lambda chars: list(chars),
        strict=False,
    )
    return "".join(re.sub(r"[^a-z0-9]", "", part.lower()) for part in parts)


def _ratio(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, _phonemes(left), _phonemes(right)).ratio()


def _meaningful_lines(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith(("#", "//"))
    ]


class HotwordManager:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or _data_dir()
        self.hot_path = self.root / "hot.txt"
        self.rule_path = self.root / "hot-rule.txt"
        self.config_path = self.root / "config.json"
        self._lock = threading.RLock()
        self._signature: tuple[int, int, int] | None = None
        self.entries: list[HotwordEntry] = []
        self.rules: list[tuple[re.Pattern[str], str]] = []
        self.enabled = True
        self.rule_enabled = True
        self.threshold = 0.85
        self.similar_threshold = 0.60
        self._ensure_files()
        self.reload(force=True)

    def _ensure_files(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.hot_path.exists():
            self.hot_path.write_text(
                "# 每行：标准词|可选别名1|可选别名2~~~可选黑名单1|可选黑名单2\n",
                encoding="utf-8",
            )
        if not self.rule_path.exists():
            self.rule_path.write_text(
                "# 每行：正则表达式 = 替换文本\n",
                encoding="utf-8",
            )
        if not self.config_path.exists():
            self.config_path.write_text(
                json.dumps(
                    {"enabled": True, "rule_enabled": True, "threshold": 0.85, "similar_threshold": 0.60},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

    def _current_signature(self) -> tuple[int, int, int]:
        return tuple(hash(path.read_bytes()) for path in (self.hot_path, self.rule_path, self.config_path))

    def reload(self, force: bool = False) -> bool:
        with self._lock:
            self._ensure_files()
            signature = self._current_signature()
            if not force and signature == self._signature:
                return False
            config = json.loads(self.config_path.read_text(encoding="utf-8") or "{}")
            self.enabled = bool(config.get("enabled", True))
            self.rule_enabled = bool(config.get("rule_enabled", True))
            self.threshold = min(1.0, max(0.0, float(config.get("threshold", 0.85))))
            self.similar_threshold = min(self.threshold, max(0.0, float(config.get("similar_threshold", 0.60))))
            self.entries = self._parse_hotwords(self.hot_path.read_text(encoding="utf-8"))
            self.rules = self._parse_rules(self.rule_path.read_text(encoding="utf-8"))
            self._signature = signature
            return True

    @staticmethod
    def _parse_hotwords(raw: str) -> list[HotwordEntry]:
        result: list[HotwordEntry] = []
        for line in _meaningful_lines(raw):
            words_part, _, blacklist_part = line.partition("~~~")
            words = tuple(item.strip() for item in words_part.split("|") if item.strip())
            if not words:
                continue
            blacklist = tuple(item.strip() for item in blacklist_part.split("|") if item.strip())
            result.append(HotwordEntry(words[0], words, blacklist))
        return result

    @staticmethod
    def _parse_rules(raw: str) -> list[tuple[re.Pattern[str], str]]:
        result: list[tuple[re.Pattern[str], str]] = []
        for line in _meaningful_lines(raw):
            if "=" not in line:
                continue
            pattern, replacement = (part.strip() for part in line.split("=", 1))
            if not pattern:
                continue
            try:
                result.append((re.compile(pattern), replacement))
            except re.error:
                continue
        return result

    def get_state(self) -> dict[str, Any]:
        self.reload()
        return {
            "enabled": self.enabled,
            "rule_enabled": self.rule_enabled,
            "threshold": self.threshold,
            "similar_threshold": self.similar_threshold,
            "hotwords": self.hot_path.read_text(encoding="utf-8"),
            "rules": self.rule_path.read_text(encoding="utf-8"),
            "hotword_count": len(self.entries),
            "rule_count": len(self.rules),
            "path": str(self.root),
        }

    def save(
        self,
        *,
        hotwords: str,
        rules: str,
        enabled: bool,
        rule_enabled: bool,
        threshold: float,
        similar_threshold: float,
    ) -> dict[str, Any]:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self.hot_path.write_text(hotwords, encoding="utf-8")
            self.rule_path.write_text(rules, encoding="utf-8")
            self.config_path.write_text(
                json.dumps(
                    {
                        "enabled": enabled,
                        "rule_enabled": rule_enabled,
                        "threshold": threshold,
                        "similar_threshold": similar_threshold,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            self.reload(force=True)
            return self.get_state()

    def apply(self, text: str, enabled: bool = True) -> HotwordApplyResult:
        self.reload()
        output = text or ""
        result = HotwordApplyResult(text=output)
        if enabled and self.enabled:
            for entry in self.entries:
                output = self._apply_entry(output, entry, result)
        if enabled and self.rule_enabled:
            for pattern, replacement in self.rules:
                before = output
                output, count = pattern.subn(replacement, output)
                if count:
                    result.replacements.append(
                        {"kind": "rule", "source": pattern.pattern, "target": replacement, "count": count}
                    )
                if output == before:
                    continue
        result.text = output
        return result

    def _apply_entry(self, text: str, entry: HotwordEntry, result: HotwordApplyResult) -> str:
        output = text
        if any(block and block in output for block in entry.blacklist):
            return output
        exact_replaced = False
        for alias in sorted(set(entry.aliases), key=len, reverse=True):
            if alias == entry.target:
                continue
            pattern = re.compile(re.escape(alias), re.IGNORECASE if alias.isascii() else 0)
            output, count = pattern.subn(entry.target, output)
            if count:
                exact_replaced = True
                result.replacements.append({"kind": "exact", "source": alias, "target": entry.target, "count": count})

        if exact_replaced:
            return output

        # Phonetic sliding-window matching is primarily for Chinese ASR errors.
        if not any("\u4e00" <= char <= "\u9fff" for char in "".join(entry.aliases)):
            return output
        occupied: list[tuple[int, int]] = []
        candidates: list[tuple[float, int, int, str]] = []
        for alias in entry.aliases:
            base = len(alias)
            for width in range(max(1, base - 1), base + 2):
                for start in range(0, max(0, len(output) - width + 1)):
                    source = output[start : start + width]
                    if source == entry.target or any(block and block in source for block in entry.blacklist):
                        continue
                    score = _ratio(source, alias)
                    if score >= self.similar_threshold:
                        candidates.append((score, start, start + width, source))
        for score, start, end, source in sorted(candidates, reverse=True):
            if any(start < used_end and end > used_start for used_start, used_end in occupied):
                continue
            if score >= self.threshold:
                occupied.append((start, end))
                result.replacements.append(
                    {"kind": "phonetic", "source": source, "target": entry.target, "score": round(score, 3)}
                )
            else:
                result.suggestions.append(
                    {"source": source, "target": entry.target, "score": round(score, 3)}
                )
        for start, end in sorted(occupied, reverse=True):
            output = output[:start] + entry.target + output[end:]
        return output


_manager: HotwordManager | None = None


def get_hotword_manager() -> HotwordManager:
    global _manager
    if _manager is None:
        _manager = HotwordManager()
    return _manager
