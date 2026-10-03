"""Immutable adapter for the pinned Hermes release and application tool policy."""
import json
import os
import shlex
import sys
from pathlib import Path

sys.path.insert(0, '/opt/hermes')
os.environ['HERMES_ACP_SKIP_CONFIGURED_MCP'] = '1'

import model_tools
from tools.registry import registry
from tools import terminal_tool
from run_agent import AIAgent

ROOT = Path(os.environ['PAI_PROJECT_ROOT']).resolve()
os.chdir(ROOT)
ALLOWED = {'read_file', 'write_file', 'patch', 'search_files', 'terminal', 'skills_list', 'skill_view', 'todo'}
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
    if name == 'terminal':
        args['force'] = False
        args['background'] = False
        args['timeout'] = min(float(args.get('timeout', 30)), 60)
        args['workdir'] = str(ROOT)
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
