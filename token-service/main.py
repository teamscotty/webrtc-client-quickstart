"""
WebRTC Token Service
====================

Reference implementation: exchanges a Scotty platform API key for a browser
join credential, so the key itself never has to reach the browser.

THIS IS A PROOF OF CONCEPT, NOT A PRODUCTION SERVICE.

  * No authentication — anyone who can reach this port can start a call.
  * No rate limiting — a caller can start unlimited sessions.
  * `continuity_key` is trusted from the request body, because this service
    has no session of its own to derive it from. That means any caller can
    resume any conversation if they can guess or observe its key.

Put this behind your own auth before exposing it beyond localhost or your
internal network — and once you do, stop trusting `continuity_key` from the
client; derive it from your authenticated session instead. See README.md.
"""

import os
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


def _load_dotenv(path: str = ".env") -> None:
    """Fill in unset environment variables from a local .env file, if any.

    Real environment variables always win — this only fills gaps, so `docker
    run -e` or a shell `export` still overrides the file. Stdlib only: this is
    three variables, not enough to justify a dependency.
    """
    try:
        lines = Path(path).read_text().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_dotenv()


def _require_env(name: str) -> str:
    try:
        return os.environ[name]
    except KeyError:
        raise SystemExit(f"missing required environment variable: {name}") from None


API_KEY = _require_env("API_KEY")
CHANNEL_DEFINITION_ID = _require_env("CHANNEL_DEFINITION_ID")
PLATFORM_URL = os.environ.get("PLATFORM_URL", "https://api.scotty-ai.com")

app = FastAPI(title="WebRTC Token Service")

# POC only: any origin may call this. A real deployment should list the exact
# pages allowed to, the same way you would scope CORS for any other API.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST"])


class CallRequest(BaseModel):
    continuity_key: uuid.UUID | None = None  # omit for a fresh conversation


@app.post("/call")
async def call(body: CallRequest | None = None):
    """Start a WebRTC session and return the client's join credential."""
    continuity_key = body.continuity_key if body else None
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{PLATFORM_URL}/v1/channels/webrtc/{CHANNEL_DEFINITION_ID}",
            headers={"API-KEY": API_KEY},
            json={
                "session_participant_id": str(uuid.uuid4()),  # fresh: one attendance
                "continuity_key": str(continuity_key) if continuity_key else None,
            },
        )
    if resp.is_error:
        # The body can echo back identifiers from the request — log it server-side,
        # don't hand it to the caller.
        print(f"platform returned {resp.status_code}: {resp.text}")
        raise HTTPException(502, "could not start the session")
    return resp.json()


@app.get("/healthz")
async def healthz():
    return {"ok": True}
