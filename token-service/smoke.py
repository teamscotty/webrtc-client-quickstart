"""
One check: the API key reaches the platform and never comes back out, and
`continuity_key` passes through untouched (there's no session here to derive
it from — see main.py's docstring).

    python smoke.py
"""

import os
from unittest.mock import AsyncMock, patch

os.environ.setdefault("API_KEY", "secret-key")
os.environ.setdefault("CHANNEL_DEFINITION_ID", "11111111-2222-3333-4444-555555555555")

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)


class StubResponse:
    is_error = False

    def json(self):
        return {"url": "wss://stub", "token": "tok", "metadata": {}}


with patch("main.httpx.AsyncClient") as MockClient:
    instance = MockClient.return_value.__aenter__.return_value
    instance.post = AsyncMock(return_value=StubResponse())

    res = client.post(
        "/call", json={"continuity_key": "00000000-0000-4000-8000-000000000000"}
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"url": "wss://stub", "token": "tok", "metadata": {}}
    assert "secret-key" not in res.text, "API key never reaches the caller"

    sent = instance.post.call_args.kwargs
    assert sent["headers"]["API-KEY"] == "secret-key", "API key reaches the platform"
    assert sent["json"]["continuity_key"] == "00000000-0000-4000-8000-000000000000"

    # An empty body is a valid request — it just means "start a fresh conversation".
    client.post("/call")
    assert instance.post.call_args.kwargs["json"]["continuity_key"] is None

print("ok — 4 checks passed")
