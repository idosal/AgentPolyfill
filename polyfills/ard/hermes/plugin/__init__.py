"""Agentic Resource Discovery v0.91 for Hermes Agent."""
from pathlib import Path
from ._card_runtime import register_plugin


def register(ctx):
    return register_plugin(ctx, Path(__file__).resolve().parent, "ard-discovery")
