"""Typed, run-scoped Home tool transport used only by the synthetic test fixture."""
import asyncio
import json

CLIENT = None
LOOP = None
SESSION = None
FIXTURE_NAME = 'planning_fixture_read'


def connect(client, loop, session):
    global CLIENT, LOOP, SESSION
    CLIENT, LOOP, SESSION = client, loop, session


def call_fixture():
    if CLIENT is None or LOOP is None or SESSION is None:
        return json.dumps({'error': 'The Home tool connection is unavailable.'})
    future = asyncio.run_coroutine_threadsafe(
        CLIENT.ext_method('pai/home_tools', {
            'sessionId': SESSION,
            'name': FIXTURE_NAME,
            'args': {},
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
        return json.dumps({'error': 'CONSENT_DENIED'})
    return json.dumps({'error': 'The Home tool result could not be validated.'})


def register_synthetic_read_only_fixture(registry):
    """Register no production Home tools; this fixed-value fixture is opt-in for tests."""
    registry.register(
        name=FIXTURE_NAME,
        toolset='home_planning',
        schema={
            'name': FIXTURE_NAME,
            'description': 'Read a fixed synthetic value for isolated transport tests. This is not Home data.',
            'parameters': {
                'type': 'object',
                'properties': {},
                'required': [],
                'additionalProperties': False,
            },
        },
        handler=lambda args, **kwargs: call_fixture(),
        check_fn=lambda: True,
    )
