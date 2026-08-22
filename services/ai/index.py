"""Vercel entry point: the Python runtime serves a module-level ASGI ``app``."""

from app.main import get_app

app = get_app()
