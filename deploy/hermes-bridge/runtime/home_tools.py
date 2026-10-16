"""Typed, run-scoped transport for the fixed Home planning tool registry."""
import asyncio
import copy
import json

try:
    from .home_tool_schemas import HOME_TOOL_DEFINITIONS, HOME_TOOL_NAMES
except ImportError:
    from home_tool_schemas import HOME_TOOL_DEFINITIONS, HOME_TOOL_NAMES

CLIENT = None
LOOP = None
SESSION = None


def connect(client, loop, session):
    global CLIENT, LOOP, SESSION
    CLIENT, LOOP, SESSION = client, loop, session


def call_home_tool(name, args):
    if name not in HOME_TOOL_NAMES or not isinstance(args, dict):
        return json.dumps({'error': 'The Home tool request is unavailable.'})
    if CLIENT is None or LOOP is None or SESSION is None:
        return json.dumps({'error': 'The Home tool connection is unavailable.'})
    future = asyncio.run_coroutine_threadsafe(
        CLIENT.ext_method('pai/home_tools', {
            'sessionId': SESSION,
            'name': name,
            'args': args,
        }),
        LOOP,
    )
    try:
        result = future.result(timeout=900)
    except Exception:
        future.cancel()
        return json.dumps({'error': 'The Home tool result could not be confirmed.'})
    if not isinstance(result, dict):
        return json.dumps({'error': 'The Home tool result could not be validated.'})
    if result.get('outcome') == 'shared' and isinstance(result.get('data'), dict):
        return json.dumps(result['data'], separators=(',', ':'))
    if result.get('outcome') == 'denied' and result.get('code') == 'CONSENT_DENIED':
        return json.dumps({'outcome': 'denied', 'code': 'CONSENT_DENIED'})
    return json.dumps({'error': 'The Home tool result could not be validated.'})


def register_home_tools(registry):
    """Register only the fixed production planning tools, with no user-controlled switches."""
    for definition in HOME_TOOL_DEFINITIONS:
        name = definition['name']
        registry.register(
            name=name,
            toolset='home_planning',
            schema={
                'name': name,
                'description': definition['description'],
                'parameters': copy.deepcopy(definition['parameters']),
            },
            handler=lambda args, _name=name, **kwargs: call_home_tool(_name, args),
            check_fn=lambda: True,
        )
