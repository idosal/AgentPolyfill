"""Test-only Python network fence, inherited by every Hermes subprocess.

Loaded through PYTHONPATH by harness.World.start (and run_card_e2e.py). The pinned host has a background
release check even with a scripted model, so local fixtures alone are not
enough to keep an integration test offline. Never installed with a plugin.
"""
import ipaddress
import os
import sys


def _loopback(host):
    if host in {None, "", "localhost", b"localhost"}:
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "strict")
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _guard(event, args):
    host = None
    if event in {"socket.connect", "socket.sendto"}:
        address = args[-1]
        if isinstance(address, tuple):
            host = address[0]
    elif event in {"socket.getaddrinfo", "socket.gethostbyname"}:
        host = args[0]
    if host is not None and not _loopback(host):
        raise PermissionError("Hermes integration tests permit loopback networking only")


if os.environ.get("AGENTPOLYFILL_OFFLINE") == "1":
    sys.addaudithook(_guard)
