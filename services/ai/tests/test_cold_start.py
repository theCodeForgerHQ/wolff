"""A cold start (every health check on Vercel) must not pay for LangChain's agents."""

import subprocess
import sys


def test_starting_the_app_does_not_load_the_langchain_agents() -> None:
    code = "import sys, app.main; print(any(m.startswith('langchain.agents') or m == 'langchain_openai' for m in sys.modules))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
