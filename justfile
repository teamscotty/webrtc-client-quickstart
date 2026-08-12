# Needs API_KEY and CHANNEL_DEFINITION_ID — set in the environment or in
# token-service/.env (copy .env.example, fill it in).
#
# Every Python recipe runs through `uv run`, so uv is the only thing you need
# installed — it manages its own Python and resolves requirements.txt on the
# fly. No system python3, no pip, no venv.

# Run the token-service at :8080.
serve-backend:
    cd token-service && uv run --with-requirements requirements.txt uvicorn main:app --reload --port 8080

# Serve the whole repo at :5500 — open http://localhost:5500/example/
serve-example:
    uv run python -m http.server 5500

# Check the token-service's contract with the platform. No API key needed.
test:
    cd token-service && uv run --with-requirements requirements.txt python smoke.py

# Syntax-check everything (no build step, so this is the whole "compile")
check:
    uv run python -m py_compile token-service/main.py
    node --check example/app.js

image:
    docker build -t webrtc-token-service token-service/
