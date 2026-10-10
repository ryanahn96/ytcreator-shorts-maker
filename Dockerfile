# Stage 1: Build React/Vite frontend
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Runtime image with Python, uv and ffmpeg
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# uv.lock records the corp PyPI mirror (Airlock, a proxy on localhost), which
# Cloud Build cannot reach, so install the same pinned versions from PyPI.
COPY pyproject.toml uv.lock ./
RUN uv export --frozen --no-dev --no-emit-project -o requirements.txt \
    && uv venv \
    && uv pip install -r requirements.txt

COPY src/ ./src/
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

ENV PATH="/app/.venv/bin:${PATH}"

# Hypercorn speaks h2c, so Cloud Run can use HTTP/2 end-to-end (--use-http2).
# Over HTTP/1, Cloud Run rejects request bodies above 32 MiB, which would
# block most Source Video uploads.
CMD exec hypercorn src.server:app --bind "0.0.0.0:${PORT:-8080}"
