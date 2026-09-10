"""The MCP server: `mcp` 2.x ``MCPServer`` with API-key auth.

Over streamable HTTP (mounted at /mcp) the bearer API key is verified per
request by ``ApiKeyTokenVerifier``. Over stdio (Claude Desktop) the key is
read from the environment and verified once at start, then fixed for the
process. Either way each tool resolves the caller from that verified key:
the workspace never comes from tool arguments, and each tool checks its
own scope. Write tools go through apps/api /internal/* with a token that
forwards the key's workspace and scopes. Every call is stored in
ai.agent_runs (kind ``mcp``).
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from decimal import Decimal
from typing import Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceError, ToolError

from app.agent import queries
from app.agent.api_client import ApiError, ApiUnavailable
from app.agent.errors import DraftError
from app.auth import AuthError, Caller, InsufficientScope
from app.budget import metered
from app.db.models import AgentRun
from app.llm.transport import LlmUnavailable
from app.mcp.auth import ApiKeyTokenVerifier, caller_from_token
from app.rag.retriever import WorkspaceRetriever
from app.services import Services

#: The read scope each searchable source type needs. There is no contracts
#: scope; a contract instance belongs to a client, so it needs clients:read.
SEARCH_SCOPES = {
    "quote": "quotes:read",
    "invoice": "invoices:read",
    "contract": "clients:read",
    "client_note": "clients:read",
}

TOOL_NAMES = (
    "search_documents",
    "list_leads",
    "create_lead",
    "list_deals",
    "move_deal",
    "get_invoice",
    "list_overdue_invoices",
    "receivables_ageing",
    "draft_quote",
    "gst_summary",
)


def build_mcp_server(svc: Services, *, fixed_caller: Caller | None = None) -> MCPServer:
    """``fixed_caller`` is for stdio (and in-process tests): a caller already
    verified from an API key. Without it, the caller comes from the HTTP
    bearer verified by the server's TokenVerifier."""
    settings = svc.settings
    public = settings.public_url.rstrip("/")
    server = MCPServer(
        settings.product_slug,
        instructions="Your quotes, invoices, leads and deals. Acts in the API key's workspace.",
        token_verifier=ApiKeyTokenVerifier(svc.sessions, settings.product_slug),
        auth=AuthSettings(
            issuer_url=public,
            resource_server_url=f"{public}/mcp",
            required_scopes=["ai:use"],
            # API keys carry no audience; the verifier authenticates them
            # against public.api_keys instead.
            validate_token_resource=False,
        ),
    )

    def current() -> Caller:
        if fixed_caller is not None:
            return fixed_caller
        token = get_access_token()
        caller = caller_from_token(token) if token else None
        if caller is None:
            raise ToolError("unauthorized")
        return caller

    async def run(
        name: str, scope: str, args: dict[str, Any], work: Callable[[Caller], Awaitable[Any]]
    ) -> Any:
        caller = current()
        started, status, error = time.monotonic(), "ok", None
        try:
            caller.require(scope)
            with metered(caller.workspace_id):
                return await work(caller)
        except AuthError as exc:
            status, error = "denied", "insufficient_scope"
            missing = str(exc).removeprefix("missing scope ")
            raise ToolError(f"This API key lacks the {missing} scope") from exc
        except (ApiError, DraftError) as exc:
            status, error = "error", getattr(exc, "code", "error")
            raise ToolError(str(exc)) from exc
        except (ApiUnavailable, LlmUnavailable) as exc:
            status, error = "error", "unavailable"
            raise ToolError("The service is busy or unavailable; try again") from exc
        except ToolError:
            status, error = "error", "not_found"
            raise
        except Exception:
            status, error = "error", "internal"
            raise
        finally:
            async with svc.sessions() as session, session.begin():
                session.add(
                    AgentRun(
                        workspace_id=caller.workspace_id,
                        kind="mcp",
                        input={"tool": name, "args": args, "key_id": caller.key_id},
                        output=None,
                        status=status,
                        latency_ms=int((time.monotonic() - started) * 1000),
                        tokens=0,
                        cost_usd=Decimal(0),
                        error=error,
                    )
                )

    async def read(fn: Callable[..., Awaitable[Any]], caller: Caller, *args: Any) -> Any:
        async with svc.sessions() as session:
            return await fn(session, caller.workspace_id, *args)

    def found(value: Any) -> Any:
        if value is None:
            raise ToolError("not found")
        return value

    @server.tool()
    async def search_documents(query: str, types: list[str] | None = None) -> list[dict[str, Any]]:
        """Search quotes, invoices, contracts and client notes; returns cited chunks.
        Only the types the key may read are searched (quotes:read, invoices:read,
        clients:read for contracts and client notes)."""

        async def work(caller: Caller) -> list[dict[str, Any]]:
            wanted = [t for t in SEARCH_SCOPES if not types or t in types]
            readable = [t for t in wanted if SEARCH_SCOPES[t] in caller.scopes]
            if not readable:
                needed = sorted({SEARCH_SCOPES[t] for t in wanted} or set(SEARCH_SCOPES.values()))
                raise InsufficientScope(f"missing scope {' or '.join(needed)}")
            docs = await WorkspaceRetriever(
                sessions=svc.sessions,
                workspace_id=caller.workspace_id,
                embed=svc.llm.embed_queries,
                embedding_model=settings.provider.embed_model,
                source_types=readable,
            ).search(query)
            return [{"content": d.page_content, **d.metadata} for d in docs]

        result: list[dict[str, Any]] = await run(
            "search_documents", "ai:use", {"query": query, "types": types}, work
        )
        return result

    @server.tool()
    async def list_leads(status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Recent leads, optionally filtered by status."""
        result: list[dict[str, Any]] = await run(
            "list_leads",
            "leads:read",
            {"status": status},
            lambda c: read(queries.list_leads, c, status, limit),
        )
        return result

    @server.tool()
    async def create_lead(
        name: str, email: str | None = None, company: str | None = None, message: str | None = None
    ) -> dict[str, Any]:
        """Create a lead (source: api)."""
        body = {"name": name, "source": "api"} | {
            k: v for k, v in {"email": email, "company": company, "message": message}.items() if v
        }
        result: dict[str, Any] = await run(
            "create_lead",
            "leads:write",
            {"name": name},
            lambda c: svc.api.post(c, "/internal/leads", body, {"leads:write"}),
        )
        return result

    @server.tool()
    async def list_deals(stage: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        """Deals in the pipeline, optionally by stage name."""
        result: list[dict[str, Any]] = await run(
            "list_deals",
            "deals:read",
            {"stage": stage},
            lambda c: read(queries.list_deals, c, stage, limit),
        )
        return result

    @server.tool()
    async def move_deal(deal_id: str, stage_id: str) -> dict[str, Any]:
        """Move a deal to another stage of its pipeline."""
        result: dict[str, Any] = await run(
            "move_deal",
            "deals:write",
            {"deal_id": deal_id, "stage_id": stage_id},
            lambda c: svc.api.post(
                c, f"/internal/deals/{deal_id}/move", {"stageId": stage_id}, {"deals:write"}
            ),
        )
        return result

    @server.tool()
    async def get_invoice(invoice_id: str) -> dict[str, Any]:
        """One invoice with its lines."""

        async def work(c: Caller) -> dict[str, Any]:
            value: dict[str, Any] = found(await read(queries.get_invoice, c, invoice_id))
            return value

        result: dict[str, Any] = await run(
            "get_invoice", "invoices:read", {"invoice_id": invoice_id}, work
        )
        return result

    @server.tool()
    async def list_overdue_invoices() -> list[dict[str, Any]]:
        """Invoices past due, most overdue first."""
        result: list[dict[str, Any]] = await run(
            "list_overdue_invoices",
            "invoices:read",
            {},
            lambda c: read(queries.overdue_invoices, c),
        )
        return result

    @server.tool()
    async def receivables_ageing() -> list[dict[str, Any]]:
        """Outstanding receivables by ageing bucket (v_receivables_ageing)."""
        result: list[dict[str, Any]] = await run(
            "receivables_ageing",
            "invoices:read",
            {},
            lambda c: read(queries.receivables_ageing, c),
        )
        return result

    @server.tool()
    async def gst_summary() -> list[dict[str, Any]]:
        """GST on outward supplies by rate (v_gst_outward_supplies)."""
        result: list[dict[str, Any]] = await run(
            "gst_summary", "reports:read", {}, lambda c: read(queries.gst_summary, c)
        )
        return result

    @server.tool(name="draft_quote")
    async def draft_quote_tool(brief: str, deal_id: str | None = None) -> dict[str, Any]:
        """Draft a quote from a brief ("Draft a quote for <client>: ..."). Creates a draft."""

        async def work(c: Caller) -> dict[str, Any]:
            from app.agent.quote_agent import draft_quote  # LangChain, only when drafting

            draft = await draft_quote(svc, c, brief, deal_id)
            return {
                "quote_id": draft.quote_id,
                "quote_number": draft.quote_number,
                "tax_pending": draft.tax_pending,
                "draft": draft.draft.model_dump(),
            }

        result: dict[str, Any] = await run(
            "draft_quote", "quotes:write", {"brief": brief, "deal_id": deal_id}, work
        )
        return result

    @server.resource("invoice://{invoice_id}", mime_type="text/markdown")
    async def invoice_resource(invoice_id: str) -> str:
        """An invoice as markdown."""
        try:
            data = await run(
                "resource:invoice",
                "invoices:read",
                {"id": invoice_id},
                lambda c: read(queries.get_invoice, c, invoice_id),
            )
        except ToolError as exc:
            raise ResourceError(str(exc)) from exc
        if data is None:
            raise ResourceError("not found")
        return _markdown("Invoice", data)

    @server.resource("quote://{quote_id}", mime_type="text/markdown")
    async def quote_resource(quote_id: str) -> str:
        """A quote as markdown."""
        try:
            data = await run(
                "resource:quote",
                "quotes:read",
                {"id": quote_id},
                lambda c: read(queries.get_quote, c, quote_id),
            )
        except ToolError as exc:
            raise ResourceError(str(exc)) from exc
        if data is None:
            raise ResourceError("not found")
        return _markdown("Quote", data)

    return server


def _markdown(kind: str, data: dict[str, Any]) -> str:
    rows = "\n".join(
        f"| {li['name']} | {li['quantity']} | {li['rate']} | {li['amount']} |"
        for li in data.get("lines", [])
    )
    total = data.get("total")
    return (
        f"# {kind} {data.get('number')}\n\nClient: {data.get('client')}  \n"
        f"Status: {data.get('status')}  \nTotal: {data.get('currency')} {total}\n\n"
        f"| Item | Qty | Rate | Amount |\n|---|---|---|---|\n{rows}\n"
    )


def mcp_http_app(server: MCPServer, public_url: str) -> Any:
    """The streamable HTTP app, to mount at /mcp. Host checks allow the
    public host and local development."""
    from urllib.parse import urlparse

    from mcp.server.transport_security import TransportSecuritySettings

    host = urlparse(public_url).netloc
    return server.streamable_http_app(
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[host, "localhost:*", "127.0.0.1:*"],
            allowed_origins=[public_url.rstrip("/")],
        ),
    )
