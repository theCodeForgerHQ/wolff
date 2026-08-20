# AI service image. Build from services/ai:
#   docker build -t ai services/ai
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.11.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /app

# Dependencies first, so code changes reuse the layer.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

RUN useradd --system --uid 10001 ai && mkdir -p /app/var && chown ai /app/var
USER ai
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"
# Migrations run as a one-off: docker run <image> alembic upgrade head
CMD ["uvicorn", "app.main:get_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
