# services/ai

FastAPI service for retrieval over workspace documents, quote drafting,
the MCP server and pandas reports. Python 3.12, managed with
[uv](https://docs.astral.sh/uv/).

```sh
uv sync                     # install
uv run ruff check . && uv run ruff format --check .
uv run mypy                 # strict
uv run pytest
uv run uvicorn app.main:get_app --factory --port 8000
```
