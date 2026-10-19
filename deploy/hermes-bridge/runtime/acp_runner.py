"""Immutable adapter for the pinned Hermes release and application tool policy."""
import json
import os
import shlex
import sys
from pathlib import Path
import asyncio
import base64
import ctypes
import hashlib
import platform
import re
import selectors
import signal
import subprocess
import threading
import time
import uuid

PROFILE_VERSION = 'bounded-read-v1'
COMMAND_LIMITS = {'wallTimeMs': 10000, 'idleTimeMs': 5000, 'maxOutputBytes': 32768,
                  'maxProcesses': 4, 'memoryBytes': 134217728, 'cpuTimeMs': 5000,
                  'network': 'denied'}
BINARIES = {name: '/usr/bin/' + name for name in ('cat', 'head', 'ls', 'pwd', 'rg', 'tail')}


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


PROFILE_HASH = digest({'version': PROFILE_VERSION, 'limits': COMMAND_LIMITS})


def command_hash(raw, manifest_hash):
    return digest({'version': PROFILE_VERSION, 'command': 'hermes-terminal', 'args': [raw],
                   'cwd': '.', 'classification': 'safe', 'limits': COMMAND_LIMITS, 'manifestHash': manifest_hash})


def parse_policy_command(raw, selected):
    if (not isinstance(raw, str) or not raw or len(raw) > 256 or raw != raw.strip()
            or re.search(r'\s{2,}|[^A-Za-z0-9_./ -]', raw)):
        raise ValueError('Invalid policy command')
    tokens = raw.split(' ')
    name, args = tokens[0], tokens[1:]
    if name not in BINARIES or any(not x or x.startswith('-') for x in args):
        raise ValueError('Command is not allowlisted')
    for value in args:
        if (value.startswith('/') or '..' in value.split('/') or re.search(
                r'(?:^|/)(?:\.env(?:\..*)?|.*(?:secret|credential|token|password|private[_-]?key|id[_-]?rsa).*|node_modules|\.git|.*(?:lock|auth|ci|config))(?:/|$)', value, re.I)):
            raise ValueError('Protected command operand')
    paths = args[1:] if name == 'rg' else args
    if name in ('cat', 'head', 'tail') and not paths:
        raise ValueError('Selected file required')
    if name == 'pwd' and args:
        raise ValueError('Unexpected arguments')
    if name == 'rg' and (not args or not re.fullmatch(r'[A-Za-z0-9_-]+', args[0])):
        raise ValueError('Literal search required')
    if any(path not in selected for path in paths):
        raise ValueError('Command path not selected')
    # rg without paths must not recursively inspect unselected or subsequently created files.
    if name == 'rg' and not paths:
        args += sorted(selected)
        if not selected:
            raise ValueError('Selected file required')
    if len(args) > 101:
        raise ValueError('Too many command operands')
    if name == 'rg':
        args = ['--threads', '1', '--fixed-strings', '--', *args]
    return [BINARIES[name], *args]


def install_child_limits():
    """Kernel-enforced bounds for a single shell-free child; no new packages."""
    import resource
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise RuntimeError('Unsupported command enforcement platform')
    resource.setrlimit(resource.RLIMIT_AS, (COMMAND_LIMITS['memoryBytes'],) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filters', ctypes.POINTER(Filter))]
    # Reject another ABI, then deny socket, process creation, namespace and bypass syscalls.
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000)]
    denied = list(range(41, 56)) + [56, 57, 58, 101, 272, 308, 310, 311, 321, 425, 426, 427, 435, 438]
    for number in denied:
        instructions += [(0x15, 0, 1, number), (0x06, 0, 0, 0x00050001)]
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    array = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    program = Program(len(instructions), array)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise RuntimeError('Command seccomp enforcement unavailable')


def enforcement_available():
    # This platform check alone is never a trusted deployment capability receipt.
    return sys.platform == 'linux' and platform.machine() == 'x86_64'


def kill_command(child):
    if hasattr(os, 'killpg'):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        child.kill()


def execute_bounded(argv, root, cancelled):
    if not enforcement_available():
        raise RuntimeError('Command enforcement unavailable')
    if cancelled.is_set():
        raise RuntimeError('Command cancelled')
    start = last_output = time.monotonic()
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    timed_out = truncated = False
    child = subprocess.Popen([sys.executable, '-I', '-S', str(Path(__file__).resolve()), '--policy-child', str(os.getpid()), json.dumps(argv)], cwd=root, shell=False, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                             env={'PATH': '/usr/bin', 'LC_ALL': 'C', 'HOME': '/nonexistent'},
                             start_new_session=True)
    selector = selectors.DefaultSelector()
    try:
        for name in streams:
            selector.register(getattr(child, name), selectors.EVENT_READ, name)
        while selector.get_map():
            now = time.monotonic()
            if cancelled.is_set() or now - start >= 10 or now - last_output >= 5:
                timed_out = not cancelled.is_set()
                kill_command(child)
                break
            for key, _ in selector.select(timeout=0.05):
                remaining = 32768 - sum(map(len, streams.values()))
                chunk = os.read(key.fileobj.fileno(), min(4096, remaining + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                last_output = time.monotonic()
                streams[key.data].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    truncated = True
                    kill_command(child)
                    break
            if truncated:
                break
        child.wait(timeout=1)
        if cancelled.is_set():
            raise RuntimeError('Command cancelled; output suppressed')
        return {'exitCode': child.returncode, 'stdout': streams['stdout'].decode('utf-8', 'ignore'),
                'stderr': streams['stderr'].decode('utf-8', 'ignore'), 'timedOut': timed_out,
                'outputTruncated': truncated, 'durationMs': int((time.monotonic() - start) * 1000)}
    finally:
        selector.close()
        if child.poll() is None:
            kill_command(child)
            child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()


class PolicyCommands:
    def __init__(self, root, binding):
        self.root = root
        self.binding = binding
        self.lock = threading.Lock()
        self.cancelled = threading.Event()

    @classmethod
    def from_environment(cls, root):
        value = os.environ.get('PAI_POLICY_BINDING')
        return cls(root, json.loads(base64.b64decode(value, validate=True))) if value else None

    def verify_snapshot(self):
        expected = self.binding['files']
        actual = {}
        directories = {parent.as_posix() for name in expected for parent in Path(name).parents if str(parent) != '.'}
        for path in self.root.rglob('*'):
            if path.is_symlink():
                raise RuntimeError('Snapshot symlink forbidden')
            if path.is_file():
                relative = path.relative_to(self.root).as_posix()
                if relative not in expected or path.stat().st_size > 256 * 1024:
                    raise RuntimeError('Snapshot contains an unselected or oversized file')
                actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            elif path.relative_to(self.root).as_posix() not in directories:
                raise RuntimeError('Snapshot contains an unselected directory')
        if actual != expected or digest([{'path': p, 'sha256': expected[p]} for p in sorted(expected)]) != self.binding['snapshotHash']:
            raise RuntimeError('Snapshot changed or does not match uploaded files')
        return actual

    @staticmethod
    def request(transport, method, params):
        if transport.CLIENT is None or transport.LOOP is None or transport.SESSION is None:
            raise RuntimeError('Policy connection unavailable')
        future = asyncio.run_coroutine_threadsafe(transport.CLIENT.ext_method(method, {
            'sessionId': transport.SESSION, **params}), transport.LOOP)
        try:
            return future.result(timeout=30)
        except Exception:
            future.cancel()
            raise RuntimeError('Policy continuation unavailable') from None

    def dispatch(self, args, transport):
        # Exceptions abort this tool; no denied synthetic result may resume the model loop.
        with self.lock:
            raw = args.get('command')
            selected = self.verify_snapshot()
            argv = parse_policy_command(raw, selected)
            if not enforcement_available() or self.cancelled.is_set():
                raise RuntimeError('Policy command unavailable')
            binding = {'runId': self.binding['runId'], 'requestId': uuid.uuid4().hex,
                       'commandHash': command_hash(raw, self.binding['manifestHash']),
                       'profileVersion': PROFILE_VERSION, 'profileHash': PROFILE_HASH,
                       'manifestHash': self.binding['manifestHash']}
            permission = self.request(transport, 'pai/policy_command', {**binding, 'command': raw})
            if not isinstance(permission, dict) or set(permission) != {'accepted', 'commandId'} or permission['accepted'] is not True:
                raise RuntimeError('Policy command not authorized')
            self.verify_snapshot()
            result = execute_bounded(argv, self.root, self.cancelled)
            if raw == 'pwd' and result['exitCode'] == 0:
                result['stdout'] = '.\n'
            self.verify_snapshot()
            receipt = self.request(transport, 'pai/policy_command_result', {
                **binding, 'commandId': permission['commandId'], 'result': result})
            if receipt != {'accepted': True} or self.cancelled.is_set():
                raise RuntimeError('Policy result withheld')
            return json.dumps(result, separators=(',', ':'))


if __name__ == '__main__' and len(sys.argv) == 4 and sys.argv[1] == '--policy-child':
    parent = int(sys.argv[2])
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent:
        sys.exit(70)
    install_child_limits()
    argv = json.loads(sys.argv[3])
    os.execve(argv[0], argv, dict(os.environ))


if __name__ == '__main__':
    sys.path.insert(0, '/opt/hermes')
    os.environ['HERMES_ACP_SKIP_CONFIGURED_MCP'] = '1'

    import model_tools
    from tools.registry import registry
    from tools import terminal_tool
    from run_agent import AIAgent
    import project_tasks

    ROOT = Path(os.environ['PAI_PROJECT_ROOT']).resolve()
    POLICY = PolicyCommands.from_environment(ROOT)
    if POLICY is not None:
        signal.signal(signal.SIGTERM, lambda *_: POLICY.cancelled.set())
        if hasattr(signal, 'SIGHUP'):
            signal.signal(signal.SIGHUP, lambda *_: POLICY.cancelled.set())
    os.chdir(ROOT)
    ALLOWED = {'read_file', 'write_file', 'patch', 'search_files', 'terminal', 'skills_list', 'skill_view', 'todo', 'project_tasks_list', 'project_task_create', 'project_task_set_status'}
    _dispatch = registry.dispatch
    _init = AIAgent.__init__
    _guards = terminal_tool._check_all_guards
    SKILLS = Path('/opt/pai/skills')


    def routine(command):
        if any(c in command for c in '\n;&|><`$'):
            return False
        try:
            parts = shlex.split(command)
        except ValueError:
            return False
        if not parts or any(p.startswith('/') or '..' in p.split('/') for p in parts):
            return False
        if parts[0] in ('pwd', 'ls', 'cat', 'head', 'tail', 'rg', 'wc'):
            safe_flags = {'-l', '-a', '-la', '-n', '-c', '-w', '--files', '--count', '-i', '-R'}
            return all(not p.startswith('-') or p in safe_flags or p[1:].isdigit() for p in parts[1:])
        if parts[0] in ('npm', 'pnpm'):
            return len(parts) >= 3 and parts[1] == 'run' and parts[2] in ('build', 'check', 'typecheck', 'test')
        if parts[0] == 'node':
            return len(parts) == 3 and parts[1] in ('--check', '-c')
        if parts[0] in ('python', 'python3'):
            return len(parts) >= 3 and parts[1:3] in (['-m', 'py_compile'], ['-m', 'compileall'])
        return False


    def command_guards(command, env_type, has_host_access=False):
        if POLICY is not None:
            raise RuntimeError('Policy commands cannot enter upstream terminal guards')
        if routine(command):
            return _guards(command, env_type, has_host_access=has_host_access)
        callback = terminal_tool._get_approval_callback()
        approved = callback(command, 'This command needs your approval', allow_permanent=False, allow_session=False) == 'once' if callback else False
        return {'approved': approved, 'user_approved': approved, 'description': 'One-time application command decision'}


    def dispatch(name, args, **kwargs):
        if name not in ALLOWED:
            return json.dumps({'error': 'This tool is not enabled by the application.'})
        args = dict(args)
        if name == 'skills_list':
            return json.dumps({'skills': [{'name': p.name, 'path': str(p / 'SKILL.md')} for p in SKILLS.iterdir() if p.is_dir()]})
        if name == 'skill_view':
            skill = args.get('name') or args.get('skill_name') or ''
            if skill not in {p.name for p in SKILLS.iterdir() if p.is_dir()}:
                return json.dumps({'error': 'Choose one of the application skills from skills_list.'})
            return (SKILLS / skill / 'SKILL.md').read_text()
        if name in ('read_file', 'write_file', 'patch', 'search_files'):
            if name == 'patch' and args.get('mode', 'replace') != 'replace':
                return json.dumps({'error': 'Use one-file replace mode or write_file in this project copy.'})
            value = args.get('path', '.')
            target = (ROOT / value).resolve()
            if not target.is_relative_to(ROOT) and not (name == 'read_file' and target.is_relative_to(Path('/opt/pai/skills'))):
                return json.dumps({'error': 'The file is outside this run project.'})
            if target.is_relative_to(ROOT) and any(p.startswith('.') or p.lower() in ('secrets', 'node_modules') for p in target.relative_to(ROOT).parts):
                return json.dumps({'error': 'Protected project paths are unavailable.'})
            args['path'] = str(target)
        if name == 'terminal' and POLICY is not None:
            try:
                return POLICY.dispatch(args, project_tasks)
            except BaseException:
                os._exit(70)
        if name == 'terminal':
            args['force'] = False
            args['background'] = False
            args['timeout'] = min(float(args.get('timeout', 30)), 60)
            args['workdir'] = str(ROOT)
        if POLICY is not None:
            with POLICY.lock:
                return _dispatch(name, args, **kwargs)
        return _dispatch(name, args, **kwargs)


    def agent_init(self, *args, **kwargs):
        kwargs['model'] = os.environ.get('PAI_MODEL', 'nvidia/nemotron-3-super-120b-a12b')
        kwargs['enabled_toolsets'] = ['file', 'terminal', 'skills', 'todo']
        kwargs['max_iterations'] = 24
        kwargs['ephemeral_system_prompt'] = (Path('/opt/pai/instructions.md').read_text() + '\nProject copy: ' + str(ROOT))
        _init(self, *args, **kwargs)


    registry.dispatch = dispatch
    terminal_tool._check_all_guards = command_guards
    AIAgent.__init__ = agent_init

    from acp_adapter import events, permissions
    _complete = events.build_tool_complete
    _start = events.build_tool_start
    _approval = permissions.make_approval_callback


    def complete(tool_call_id, tool_name, **kwargs):
        event = _complete(tool_call_id, tool_name, **kwargs)
        if tool_name == 'terminal':
            event.raw_output = kwargs.get('result')
        return event


    def approval(*args, **kwargs):
        kwargs['timeout'] = 300
        if len(args) >= 3:
            project_tasks.connect(args[0].__self__, args[1], args[2])
        return _approval(*args, **kwargs)


    events.build_tool_complete = complete
    def start(tool_call_id, tool_name, arguments, **kwargs):
        event = _start(tool_call_id, tool_name, arguments, **kwargs)
        if tool_name == 'terminal':
            event.raw_input = arguments
        return event


    events.build_tool_start = start
    permissions.make_approval_callback = approval

    from acp_adapter.entry import main
    main()
