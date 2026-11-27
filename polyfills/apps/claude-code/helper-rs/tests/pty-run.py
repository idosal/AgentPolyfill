# Runs a command in a pseudo-terminal and answers its questions, for the tests that
# need a real terminal. Standard library only; run with `python3 -I`.
#   python3 -I pty-run.py "answer 1|answer 2|…" -- command args…
# Each answer is typed (with Enter) when the command shows its next "[y/N/?]"
# question; what the command printed is written to standard output.
import os
import pty
import select
import sys
import time

answers = sys.argv[1].split("|")
command = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
out = b""
sent = 0
deadline = time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if out.count(b"[y/N/?]") > sent and sent < len(answers):
        os.write(fd, (answers[sent] + "\n").encode())
        sent += 1
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
sys.stdout.buffer.write(out)
