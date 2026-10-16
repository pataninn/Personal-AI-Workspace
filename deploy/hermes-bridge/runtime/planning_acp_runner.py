"""Hermes ACP runner for Home planning; no filesystem, terminal, skill, or todo tools."""
import os
import sys
from pathlib import Path

sys.path.insert(0, '/opt/hermes')
os.environ['HERMES_ACP_SKIP_CONFIGURED_MCP'] = '1'

import model_tools
from tools.registry import registry
from run_agent import AIAgent
import home_tools

PLANNING_CWD = Path(os.environ['PAI_PLANNING_CWD']).resolve()
if 'PAI_PROJECT_ROOT' in os.environ or not PLANNING_CWD.is_dir() or any(PLANNING_CWD.iterdir()):
    raise RuntimeError('The isolated planning working directory is not empty.')
os.chdir(PLANNING_CWD)

FIXTURE_ENABLED = os.environ.get('PAI_PLANNING_FIXTURE') == '1'
ALLOWED = {home_tools.FIXTURE_NAME} if FIXTURE_ENABLED else set()
try:
    MAX_OUTPUT_TOKENS = int(os.environ.get('PAI_PLANNING_MAX_TOKENS', '512'))
except ValueError:
    raise RuntimeError('The planning output token limit is invalid.') from None
if not 1 <= MAX_OUTPUT_TOKENS <= 512:
    raise RuntimeError('The planning output token limit is outside its bound.')
if FIXTURE_ENABLED:
    home_tools.register_synthetic_read_only_fixture(registry)

_dispatch = registry.dispatch
_init = AIAgent.__init__


def dispatch(name, args, **kwargs):
    if name not in ALLOWED:
        return '{"error":"This typed Home tool is not enabled for this run."}'
    return _dispatch(name, args, **kwargs)


def agent_init(self, *args, **kwargs):
    kwargs['model'] = os.environ['PAI_MODEL']
    kwargs['api_mode'] = 'chat_completions'
    kwargs['enabled_toolsets'] = ['home_planning'] if FIXTURE_ENABLED else []
    kwargs['max_iterations'] = 12
    kwargs['max_tokens'] = MAX_OUTPUT_TOKENS
    kwargs['skip_context_files'] = True
    kwargs['load_soul_identity'] = False
    kwargs['skip_memory'] = True
    kwargs['skip_background_review'] = True
    kwargs['fallback_model'] = []
    kwargs['credential_pool'] = None
    kwargs['save_trajectories'] = False
    kwargs['checkpoints_enabled'] = False
    kwargs['quiet_mode'] = True
    kwargs['ephemeral_system_prompt'] = (
        'You are the Home planning assistant. Use only explicitly available typed Home tools. '
        'Never access files, run commands, use skills, or use project context. '
        'If no tool is available, answer only from the supplied conversation context.'
    )
    _init(self, *args, **kwargs)


registry.dispatch = dispatch
AIAgent.__init__ = agent_init

from acp_adapter import permissions

_approval = permissions.make_approval_callback


def approval(*args, **kwargs):
    if len(args) >= 3:
        home_tools.connect(args[0].__self__, args[1], args[2])
    kwargs['timeout'] = 900
    return _approval(*args, **kwargs)


permissions.make_approval_callback = approval

from acp_adapter.entry import main

main()
