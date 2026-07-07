from app.tasks.asr_task import run_asr_task
from app.tasks.celery_app import celery_app


def test_long_audio_task_does_not_depend_on_result_backend() -> None:
    assert celery_app.conf.task_ignore_result is True
    assert celery_app.conf.task_store_errors_even_if_ignored is False
    assert run_asr_task.ignore_result is True
