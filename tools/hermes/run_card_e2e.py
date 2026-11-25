"""Run a form's test/e2e_test.py with even the outer interpreter in an isolated home.

Invoke with system python3 from either Hermes form; HERMES_PYTHON and HERMES_SRC
must already name the pinned installation. The harness isolates every gateway again.
"""
import os
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

with tempfile.TemporaryDirectory(prefix="card-e2e-runner-") as tmp:
    guard = str(Path(__file__).resolve().parent / "offline")
    # Only the system's basics and the pinned Hermes's location: no token or key of the shell's.
    keep = ("PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL", "TZ", "HERMES_PYTHON", "HERMES_SRC")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(HOME=tmp, HERMES_HOME=str(Path(tmp) / "hermes"), PYTHONDONTWRITEBYTECODE="1",
               PYTHONPATH=guard, AGENTPOLYFILL_OFFLINE="1")
    command = [env["HERMES_PYTHON"], "test/e2e_test.py", "-v", *sys.argv[1:]]
    # On macOS fence every descendant too, including Node and host subprocesses.
    # Unix-domain IPC remains available; Internet sockets may reach only loopback.
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        command = ["sandbox-exec", "-p", '(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))', *command]
    result = subprocess.run(command, env=env)
    raise SystemExit(result.returncode)
