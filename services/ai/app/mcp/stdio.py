"""stdio MCP server for desktop clients.

    <SLUG>_API_KEY=wolff_sk_... AI_DATABASE_URL=... uv run python -m app.mcp.stdio

The key is verified once at start like an HTTP bearer; the process then
acts only in that key's workspace.
"""

from __future__ import annotations

import asyncio
import os
import sys

from app.mcp.auth import ApiKeyTokenVerifier, caller_from_token
from app.mcp.server import build_mcp_server
from app.services import build_services
from app.settings import load_settings


async def main() -> int:
    settings = load_settings()
    env_name = f"{settings.product_slug.upper().replace('-', '_')}_API_KEY"
    raw = os.environ.get(env_name, "")
    svc = build_services(settings)
    try:
        token = await ApiKeyTokenVerifier(svc.sessions, settings.product_slug).verify_token(raw)
        caller = caller_from_token(token) if token else None
        if caller is None:
            print(f"{env_name} is missing, invalid, revoked or lacks ai:use", file=sys.stderr)
            return 2
        await build_mcp_server(svc, fixed_caller=caller).run_stdio_async()
        return 0
    finally:
        await svc.aclose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
