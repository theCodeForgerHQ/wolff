"""LangChain tools bound to one authenticated caller.

The workspace is closed over from the caller; no tool has a workspace
parameter, so a model (or a prompt injected into a document) cannot point
a tool at another workspace.
"""

from __future__ import annotations

import functools
import html
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent import queries
from app.rag.retriever import Embed, WorkspaceRetriever

SOURCE_TYPES = ["quote", "invoice", "contract", "client_note"]


@dataclass
class Evidence:
    """What the tools returned during one run, for citations and guards."""

    documents: list[dict[str, Any]] = field(default_factory=list)
    searched: bool = False
    tools_used: list[str] = field(default_factory=list)


def _dump(value: object) -> str:
    return json.dumps(value, default=str)


def _quote_document(n: int, content: str) -> str:
    # Wrapped and labelled as data. The content
    # is escaped so a document cannot close its wrapper and continue as
    # instructions.
    return f'<document n="{n}">\n{html.escape(content, quote=False)}\n</document>'


def chat_tools(
    *,
    workspace_id: str,
    sessions: async_sessionmaker[AsyncSession],
    embed: Embed,
    embedding_model: str,
    evidence: Evidence,
) -> list[BaseTool]:
    def tool(name: str, description: str) -> Callable[[Callable[..., Awaitable[str]]], BaseTool]:
        def wrap(fn: Callable[..., Awaitable[str]]) -> BaseTool:
            @functools.wraps(fn)
            async def run(*args: Any, **kwargs: Any) -> str:
                evidence.tools_used.append(name)
                return await fn(*args, **kwargs)

            return StructuredTool.from_function(coroutine=run, name=name, description=description)

        return wrap

    async def read(fn: Callable[..., Awaitable[Any]], *args: Any) -> str:
        async with sessions() as session:
            return _dump(await fn(session, workspace_id, *args))

    @tool(
        "search_documents", "Search the workspace's quotes, invoices, contracts and client notes."
    )
    async def search_documents(query: str, types: list[str] | None = None) -> str:
        evidence.searched = True
        wanted = [t for t in (types or []) if t in SOURCE_TYPES] or None
        docs = await WorkspaceRetriever(
            sessions=sessions,
            workspace_id=workspace_id,
            embed=embed,
            embedding_model=embedding_model,
            source_types=wanted,
        ).search(query)
        out = []
        for doc in docs:
            n = len(evidence.documents) + 1
            entry = {
                "n": n,
                "source_type": doc.metadata["source_type"],
                "source_id": doc.metadata["source_id"],
                "label": doc.metadata.get("number") or doc.metadata.get("client_name") or "",
                "content": _quote_document(n, doc.page_content),
            }
            evidence.documents.append(entry)
            out.append(entry)
        return _dump({"documents": out})

    @tool("list_overdue_invoices", "Invoices past their due date with the amount still due.")
    async def list_overdue_invoices() -> str:
        return await read(queries.overdue_invoices)

    @tool("receivables_ageing", "Outstanding receivables by ageing bucket and currency.")
    async def receivables_ageing() -> str:
        return await read(queries.receivables_ageing)

    @tool("top_debtors", "Clients who owe the most, with the amount due.")
    async def top_debtors() -> str:
        return await read(queries.top_debtors)

    @tool("gst_summary", "GST on outward supplies, by rate.")
    async def gst_summary() -> str:
        return await read(queries.gst_summary)

    @tool("list_leads", "Recent leads, optionally by status.")
    async def list_leads(status: str | None = None) -> str:
        return await read(queries.list_leads, status)

    @tool("list_deals", "Deals in the pipeline, optionally by stage name.")
    async def list_deals(stage: str | None = None) -> str:
        return await read(queries.list_deals, stage)

    @tool("get_invoice", "One invoice with its lines, by id.")
    async def get_invoice(invoice_id: str) -> str:
        return await read(queries.get_invoice, invoice_id)

    return [
        search_documents,
        list_overdue_invoices,
        receivables_ageing,
        top_debtors,
        gst_summary,
        list_leads,
        list_deals,
        get_invoice,
    ]
