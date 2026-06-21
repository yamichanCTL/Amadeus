from __future__ import annotations

from httpx import ASGITransport, AsyncClient


async def test_public_ipv4_frontend_origin_is_allowed() -> None:
    from app.main import create_app

    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        resp = await client.options(
            "/v1/tts/higgs/reference-asr",
            headers={
                "Origin": "http://112.124.13.120:5173",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://112.124.13.120:5173"
