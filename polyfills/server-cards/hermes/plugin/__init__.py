"""MCP Server Cards (SEP-2127) for Hermes Agent."""
from pathlib import Path
from ._card_runtime import register_plugin


def register(ctx):
    return register_plugin(ctx, Path(__file__).resolve().parent, "mcp-server-cards")
