from __future__ import annotations

import json

from app.core.asr.hotwords import HotwordManager


def make_manager(tmp_path) -> HotwordManager:
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "hot.txt").write_text("撒贝宁|撒贝你|撒贝林~~~撒贝宁工作室\n", encoding="utf-8")
    (tmp_path / "hot-rule.txt").write_text("50赫兹 = 50Hz\n", encoding="utf-8")
    (tmp_path / "config.json").write_text(json.dumps({
        "enabled": True,
        "rule_enabled": True,
        "threshold": 0.85,
        "similar_threshold": 0.6,
    }), encoding="utf-8")
    return HotwordManager(tmp_path)


def test_hotword_alias_and_rule(tmp_path) -> None:
    manager = make_manager(tmp_path)
    result = manager.apply("撒贝你说国内交流电一般是50赫兹")
    assert result.text == "撒贝宁说国内交流电一般是50Hz"
    assert {item["kind"] for item in result.replacements} == {"exact", "rule"}


def test_hotword_blacklist(tmp_path) -> None:
    manager = make_manager(tmp_path)
    assert manager.apply("撒贝宁工作室采访撒贝你").text == "撒贝宁工作室采访撒贝你"


def test_hotword_files_reload_without_restart(tmp_path) -> None:
    manager = make_manager(tmp_path)
    assert manager.apply("小爱同学").text == "小爱同学"
    manager.hot_path.write_text("小爱同学|小艾同学\n", encoding="utf-8")
    assert manager.apply("小艾同学").text == "小爱同学"


def test_invalid_regex_rule_is_ignored(tmp_path) -> None:
    manager = make_manager(tmp_path)
    manager.rule_path.write_text("[ = invalid\n正常 = OK\n", encoding="utf-8")
    assert manager.apply("正常").text == "OK"
