"""A stand-in for Hermes's approval modules, for unit tests that run without Hermes.

``_servers.approvals_bypassed`` evaluates Hermes's own gate predicate (``tools.approval._yolo_active()``,
``tools.approval_context._get_approval_mode()``, ``is_approval_bypass_active_for_session``). Without
Hermes it can't, and refuses. These modules let a test say how Hermes would answer.
"""
import sys
import types
from unittest.mock import patch


def hermes_approval(yolo: bool = False, mode: str = "manual", session_yolo: tuple = ()):
    """``patch.dict(sys.modules, ...)`` with ``tools.approval`` and ``tools.approval_context``.

    ``yolo`` is what ``_yolo_active()`` returns (``--yolo``, the current session's ``/yolo``, or an
    unattended ``hermes -z`` turn); ``mode`` is ``approvals.mode``; ``session_yolo`` the session keys
    with ``/yolo`` on."""
    pkg = types.ModuleType("tools")
    pkg.__path__ = []
    approval = types.ModuleType("tools.approval")
    approval._yolo_active = lambda: yolo
    approval.is_approval_bypass_active_for_session = lambda key: key in session_yolo or mode == "off"
    context = types.ModuleType("tools.approval_context")
    context._get_approval_mode = lambda: mode
    pkg.approval, pkg.approval_context = approval, context
    return patch.dict(sys.modules, {"tools": pkg, "tools.approval": approval, "tools.approval_context": context})
