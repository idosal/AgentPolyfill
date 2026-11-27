"""Exercise the installed plugin in an isolated Hermes gateway with a local Tasks server."""
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE.parents[2] / 'tools/hermes'))
from harness import World

with tempfile.TemporaryDirectory() as tmp:
    log = Path(tmp) / 'calls'
    world = World({'mcp-tasks': HERE / 'plugin'}, entries={'mcp-tasks': {
        'settings': {'servers': ['jobs']}, 'allow_gateway_injection': True}},
        mcp_servers={'jobs': {'command': shutil.which('node'), 'args': [
            str(HERE.parent / 'codex/test/fixture-tasks-server.mjs')], 'env': {'FIXTURE_LOG': str(log)}}})
    try:
        gateway = world.start()
        created = gateway.request('session.create', {})
        session = created['session_id']
        def command(text, sid=session):
            return gateway.request('slash.exec', {'session_id': sid, 'command': 'mcp-tasks ' + text})['output']

        def calls(method):
            return [m for line in log.read_text().splitlines() if (m := json.loads(line))['method'] == method]

        assert 'jobs' in command('servers')
        gateway.answer = lambda method, params: {'answers': {'q0': 'Decline'}}
        command('start jobs ask {}')
        assert not calls('tools/call')
        gateway.answer = lambda method, params: {'answers': {'q0': 'Approve'}}
        start = command('start jobs ask {}')
        match = re.search(r't-[0-9a-f]{6}', start)
        assert match, start
        task = match[0]
        assert task not in command('list', world.session())
        for _ in range(35):
            if 'input_required' in command('get ' + task):
                break
            time.sleep(.4)
        world.wait_turn(session, 0, timeout=20)
        query = command('input ' + task)
        assert 'name' in query and 'JSON' in query, query
        command('input ' + task + ' {"name":7}')
        assert not calls('tasks/update')
        reply = command('input ' + task + ' {"name":"Luca"}')
        assert 'Sent 1' in reply, reply
        for _ in range(35):
            final = command('result ' + task)
            if 'Hello, Luca!' in final:
                break
            time.sleep(.4)
        assert 'Hello, Luca!' in final, final
        assert len(calls('tools/call')) == len(calls('tasks/update')) == 1
        world.stop()
        gateway = world.start()
        resumed = gateway.request('session.resume', {'session_id': created['stored_session_id']})
        restored = command('result ' + task, resumed['session_id'])
        assert 'Hello, Luca!' in restored, restored
        world.config['plugins']['entries']['mcp-tasks']['settings']['servers'] = []
        world.write_config(world.config)
        command('start jobs ask {}', resumed['session_id'])
        assert len(calls('tools/call')) == 1
        print('Hermes gateway verified consent, isolation, input, wake, restart, and grant revocation.')
    finally:
        world.close()
