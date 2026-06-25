"""
Tests for VoicePreset, ConvertResult, and voice registry functions.
"""

from runner.voice.converter import (
    ConvertResult,
    VoicePreset,
    add_voice,
    get_voice,
    list_voices,
)


class TestVoicePreset:
    """VoicePreset dataclass tests."""

    def test_valid_preset(self) -> None:
        p = VoicePreset(
            id="test_voice",
            name="Test Voice",
            ref_audio="/tmp/test.wav",
            prompt_text="Hello",
            prompt_lang="en",
            description="A test voice",
        )
        assert p.id == "test_voice"
        assert p.name == "Test Voice"
        assert p.ref_audio == "/tmp/test.wav"
        assert p.prompt_text == "Hello"
        assert p.prompt_lang == "en"
        assert p.description == "A test voice"

    def test_default_prompt_text_empty(self) -> None:
        p = VoicePreset(id="v", name="V", ref_audio="/tmp/x.wav")
        assert p.prompt_text == ""

    def test_default_prompt_lang_zh(self) -> None:
        p = VoicePreset(id="v", name="V", ref_audio="/tmp/x.wav")
        assert p.prompt_lang == "zh"

    def test_default_description_empty(self) -> None:
        p = VoicePreset(id="v", name="V", ref_audio="/tmp/x.wav")
        assert p.description == ""


class TestConvertResult:
    """ConvertResult dataclass tests."""

    def test_success_result(self) -> None:
        r = ConvertResult(success=True, input_text="你好", output_path="/tmp/out.wav")
        assert r.success is True
        assert r.input_text == "你好"
        assert r.output_path == "/tmp/out.wav"
        assert r.error == ""

    def test_failure_result(self) -> None:
        r = ConvertResult(success=False, error="File not found")
        assert r.success is False
        assert r.error == "File not found"

    def test_default_values(self) -> None:
        r = ConvertResult(success=True)
        assert r.input_text == ""
        assert r.output_path == ""
        assert r.input_duration == 0.0
        assert r.output_duration == 0.0
        assert r.asr_duration == 0.0
        assert r.tts_duration == 0.0
        assert r.total_duration == 0.0
        assert r.voice_id == ""
        assert r.voice_name == ""
        assert r.error == ""

    def test_timing_fields(self) -> None:
        r = ConvertResult(
            success=True,
            asr_duration=0.5,
            tts_duration=1.2,
            total_duration=1.8,
            voice_id="elysia",
            voice_name="Elysia",
        )
        assert r.asr_duration == 0.5
        assert r.tts_duration == 1.2
        assert r.total_duration == 1.8
        assert r.voice_id == "elysia"
        assert r.voice_name == "Elysia"


class TestVoiceRegistry:
    """Tests for list_voices, get_voice, add_voice functions."""

    def test_list_voices_returns_builtin_presets(self) -> None:
        voices = list_voices()
        assert len(voices) >= 4
        ids = {v.id for v in voices}
        assert "elysia" in ids
        assert "original" in ids
        assert "voxcpm_elysia" in ids
        assert "voxcpm_design" in ids

    def test_get_voice_existing(self) -> None:
        voice = get_voice("elysia")
        assert voice is not None
        assert voice.id == "elysia"
        assert voice.name == "Elysia"

    def test_get_voice_nonexistent(self) -> None:
        voice = get_voice("nonexistent_voice_id")
        assert voice is None

    def test_add_and_get_custom_voice(self) -> None:
        preset = VoicePreset(
            id="custom_test",
            name="Custom Test",
            ref_audio="/tmp/custom.wav",
        )
        add_voice(preset)
        fetched = get_voice("custom_test")
        assert fetched is not None
        assert fetched.id == "custom_test"
        assert fetched.name == "Custom Test"

    def test_list_voices_includes_custom_after_add(self) -> None:
        preset = VoicePreset(id="custom2", name="Custom2", ref_audio="/tmp/x.wav")
        add_voice(preset)
        voices = list_voices()
        ids = {v.id for v in voices}
        assert "custom2" in ids

    def test_get_voice_original_preset(self) -> None:
        voice = get_voice("original")
        assert voice is not None
        assert voice.name == "原始录音"
        assert voice.prompt_lang == "ja"

    def test_get_voice_voxcpm_design_no_ref(self) -> None:
        voice = get_voice("voxcpm_design")
        assert voice is not None
        assert voice.ref_audio == ""  # no reference — voice design mode

    def test_all_builtin_voices_have_unique_ids(self) -> None:
        voices = list_voices()
        ids = [v.id for v in voices]
        assert len(ids) == len(set(ids))
