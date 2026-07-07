from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_scheduler_metrics_endpoint_shape() -> None:
    from app.api.v1.models import scheduler_metrics

    data = await scheduler_metrics()

    assert data["enabled"] is True
    assert data["max_wait_ms"] == 100
    assert data["max_batch_items"] >= 1
    assert "submitted" in data["metrics"]
    assert "batches" in data["metrics"]
