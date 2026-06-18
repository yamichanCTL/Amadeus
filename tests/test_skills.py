"""Tests for the Skill system."""

from __future__ import annotations

import pytest

from runner.skills.base import SkillCall, SkillResult
from runner.skills.registry import SkillRegistry
from runner.skills.executor import FunctionExecutor


class TestSkillCall:
    """Test SkillCall validation."""

    def test_valid_call(self) -> None:
        call = SkillCall(name="get_project_tree", params={"max_depth": 2})
        assert call.name == "get_project_tree"
        assert call.params == {"max_depth": 2}

    def test_empty_name_raises(self) -> None:
        with pytest.raises(ValueError, match="must not be blank"):
            SkillCall(name="")

    def test_blank_name_raises(self) -> None:
        with pytest.raises(ValueError, match="must not be blank"):
            SkillCall(name="   ")


class TestSkillResult:
    """Test SkillResult construction."""

    def test_success_result(self) -> None:
        result = SkillResult(skill="test", success=True, output="done")
        assert result.success is True
        assert result.output == "done"
        assert not result.permission_denied

    def test_failure_result(self) -> None:
        result = SkillResult(skill="test", success=False, error="something went wrong")
        assert result.success is False
        assert result.error == "something went wrong"

    def test_permission_denied(self) -> None:
        result = SkillResult(skill="test", permission_denied=True, error="blocked")
        assert result.permission_denied is True

    def test_to_log_entry(self) -> None:
        result = SkillResult(skill="test", success=True, output="hello")
        entry = result.to_log_entry()
        assert entry["skill"] == "test"
        assert entry["success"] is True


class TestSkillRegistry:
    """Test SkillRegistry registration and execution."""

    def test_list_builtin_skills(self) -> None:
        registry = SkillRegistry()
        skills = registry.list_skills()
        skill_names = {s["name"] for s in skills}
        expected = {
            "get_project_tree",
            "read_text_file",
            "write_temporary_memory",
            "get_git_status",
            "run_safe_command",
        }
        assert skill_names == expected

    def test_has_skill(self) -> None:
        registry = SkillRegistry()
        assert registry.has("get_project_tree") is True
        assert registry.has("nonexistent") is False

    def test_unknown_skill_returns_error(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(SkillCall(name="nonexistent"))
        assert result.success is False
        assert "Unknown" in result.error

    def test_missing_required_param(self) -> None:
        registry = SkillRegistry()
        # read_text_file requires "path"
        result = registry.execute(SkillCall(name="read_text_file", params={}))
        assert result.success is False
        assert "Missing" in result.error

    def test_get_project_tree(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(SkillCall(name="get_project_tree", params={"max_depth": 2}))
        assert result.success is True
        assert len(result.output) > 0
        assert result.metadata["file_count"] > 0

    def test_get_git_status(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(SkillCall(name="get_git_status"))
        # Should succeed (we're in a git repo)
        assert result.success is True
        assert "clean" in result.output.lower() or result.output.strip() != ""

    def test_read_text_file_safety(self) -> None:
        registry = SkillRegistry()
        # Try to read outside project
        result = registry.execute(
            SkillCall(name="read_text_file", params={"path": "/etc/passwd"})
        )
        assert result.success is False
        assert result.permission_denied or "outside" in result.error.lower()

    def test_read_valid_file(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(
            SkillCall(name="read_text_file", params={"path": "pyproject.toml"})
        )
        assert result.success is True
        assert "asr-backend" in result.output or "asrapp" in result.output.lower()

    def test_run_safe_command_allowed(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(
            SkillCall(name="run_safe_command", params={"command": "ls -la"})
        )
        # ls is allowed, should succeed
        assert result.success is True

    def test_run_safe_command_blocked(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(
            SkillCall(name="run_safe_command", params={"command": "rm -rf /"})
        )
        # rm is not in allowlist
        assert result.success is False
        assert result.permission_denied or "not in allowlist" in result.error.lower()

    def test_write_temporary_memory(self) -> None:
        registry = SkillRegistry()
        result = registry.execute(
            SkillCall(
                name="write_temporary_memory",
                params={"summary": "Test memory from pytest"},
            )
        )
        assert result.success is True


class TestFunctionExecutor:
    """Test FunctionExecutor wrapping."""

    def test_execute_valid_skill(self) -> None:
        executor = FunctionExecutor()
        result = executor.execute(SkillCall(name="get_git_status"))
        assert result.success is True

    def test_list_skills(self) -> None:
        executor = FunctionExecutor()
        skills = executor.list_skills()
        assert len(skills) >= 5
        names = {s["name"] for s in skills}
        assert "get_project_tree" in names
