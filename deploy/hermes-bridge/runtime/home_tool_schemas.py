"""Fixed, bounded JSON schemas for Home planning tools."""


def _object(properties, required=()):
    return {
        'type': 'object',
        'properties': properties,
        'required': list(required),
        'additionalProperties': False,
    }


def _string(minimum=None, maximum=None, pattern=None, description=None):
    value = {'type': 'string'}
    if minimum is not None:
        value['minLength'] = minimum
    if maximum is not None:
        value['maxLength'] = maximum
    if pattern is not None:
        value['pattern'] = pattern
    if description is not None:
        value['description'] = description
    return value


UUID = _string(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
VERSION = {'type': 'integer', 'minimum': 1, 'maximum': 2147483647}
DATE = _string(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
TITLE = _string(1, 120)
DETAILS = {'anyOf': [_string(maximum=4096), {'type': 'null'}]}
OBJECTIVE = {'anyOf': [_string(maximum=2000), {'type': 'null'}]}
IMPORTANCE = {'type': 'string', 'enum': ['low', 'medium', 'high', 'urgent']}
TASK_STATUS = {'type': 'string', 'enum': ['todo', 'in_progress', 'blocked', 'done']}
QUERY_STATUS = {'type': 'string', 'enum': ['todo', 'in_progress', 'blocked', 'done', 'archived']}

DEADLINE_INPUT = {
    'anyOf': [
        _object(
            {'kind': {'type': 'string', 'enum': ['date']}, 'value': DATE},
            ['kind', 'value'],
        ),
        _object(
            {
                'kind': {'type': 'string', 'enum': ['days_from_today']},
                'days': {'type': 'integer', 'minimum': 0, 'maximum': 365},
            },
            ['kind', 'days'],
        ),
    ]
}
NULLABLE_DEADLINE = {'anyOf': [DEADLINE_INPUT, {'type': 'null'}]}


def _subtask(allow_existing_id=False):
    properties = {'title': TITLE, 'completed': {'type': 'boolean'}}
    if allow_existing_id:
        properties['id'] = UUID
    return _object(properties, ['title'])


SUBTASKS_CREATE = {'type': 'array', 'maxItems': 50, 'items': _subtask()}
SUBTASKS_UPDATE = {'type': 'array', 'maxItems': 50, 'items': _subtask(allow_existing_id=True)}
WORKSPACE_REF = _object(
    {'workspaceRef': {'type': 'integer', 'minimum': 1, 'maximum': 20}},
    ['workspaceRef'],
)
WORKSPACE_TARGET = {'anyOf': [UUID, {'type': 'null'}, WORKSPACE_REF]}


def _update_task_schema(action=None):
    prefix = {}
    required = []
    if action is not None:
        prefix['action'] = {'type': 'string', 'enum': [action]}
        required.append('action')
    prefix.update({'taskId': UUID, 'expectedVersion': VERSION})
    required.extend(['taskId', 'expectedVersion'])
    common = {
        'title': TITLE,
        'details': DETAILS,
        'importance': IMPORTANCE,
        'deadline': NULLABLE_DEADLINE,
        'subtasks': SUBTASKS_UPDATE,
    }
    status_branch = _object(
        {**prefix, 'status': TASK_STATUS},
        [*required, 'status'],
    )
    patch_branches = [
        _object({**prefix, **common}, [*required, field])
        for field in common
    ]
    return {'anyOf': [status_branch, *patch_branches]}


def _bulk_create_task_schema():
    return _object(
        {
            'action': {'type': 'string', 'enum': ['task.create']},
            'title': TITLE,
            'details': DETAILS,
            'workspaceId': WORKSPACE_TARGET,
            'importance': IMPORTANCE,
            'deadline': NULLABLE_DEADLINE,
            'subtasks': SUBTASKS_CREATE,
            'expectedOrderVersion': VERSION,
        },
        ['action', 'title'],
    )


def _bulk_task_move_schema():
    return _object(
        {
            'action': {'type': 'string', 'enum': ['task.move']},
            'taskId': UUID,
            'expectedVersion': VERSION,
            'workspaceId': WORKSPACE_TARGET,
            'expectedSourceOrderVersion': VERSION,
            'expectedDestinationOrderVersion': VERSION,
        },
        ['action', 'taskId', 'expectedVersion', 'workspaceId'],
    )


def _bulk_task_archive_schema():
    return _object(
        {
            'action': {'type': 'string', 'enum': ['task.archive']},
            'taskId': UUID,
            'expectedVersion': VERSION,
            'expectedOrderVersion': VERSION,
        },
        ['action', 'taskId', 'expectedVersion'],
    )


def _bulk_workspace_create_schema():
    return _object(
        {
            'action': {'type': 'string', 'enum': ['workspace.create']},
            'name': TITLE,
            'objective': OBJECTIVE,
        },
        ['action', 'name'],
    )


def _bulk_workspace_update_schema():
    return _object(
        {
            'action': {'type': 'string', 'enum': ['workspace.update_objective']},
            'workspaceId': UUID,
            'expectedVersion': VERSION,
            'objective': OBJECTIVE,
        },
        ['action', 'workspaceId', 'expectedVersion', 'objective'],
    )


HOME_TOOL_DEFINITIONS = (
    {
        'name': 'home_list_tasks',
        'description': 'List bounded task metadata visible in the current Home conversation scope. Use this before a task update, move, or archive when the exact target is unclear. Never infer that a listed task should be changed.',
        'parameters': _object({
            'workspaceId': UUID,
            'inboxOnly': {'type': 'boolean'},
            'status': QUERY_STATUS,
            'importance': IMPORTANCE,
            'deadlineFrom': DATE,
            'deadlineTo': DATE,
            'q': _string(maximum=200),
            'includeArchived': {'type': 'boolean'},
            'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20},
            'cursor': _string(maximum=1024),
        }),
    },
    {
        'name': 'home_get_task',
        'description': 'Read one task by its exact ID in the current Home conversation scope. Use only when the user asks for details or after the target is unambiguous.',
        'parameters': _object({'taskId': UUID, 'includeArchived': {'type': 'boolean'}}, ['taskId']),
    },
    {
        'name': 'home_create_task',
        'description': 'Create exactly one task only when the user explicitly asks for that single task. For a multi-item change, use home_propose_bulk_changes so no proposed item is written before review.',
        'parameters': _object({
            'title': TITLE,
            'details': DETAILS,
            'workspaceId': {'anyOf': [UUID, {'type': 'null'}]},
            'importance': IMPORTANCE,
            'deadline': NULLABLE_DEADLINE,
            'subtasks': SUBTASKS_CREATE,
            'expectedOrderVersion': VERSION,
        }, ['title']),
    },
    {
        'name': 'home_update_task',
        'description': 'Change exactly one task only when the user explicitly requests that single change. Provide either status alone or a non-empty patch. Read the current task first if its exact ID and version are not known.',
        'parameters': _update_task_schema(),
    },
    {
        'name': 'home_move_task',
        'description': 'Move exactly one task only when explicitly requested. Use the exact task ID, current version, and destination workspace ID; null selects Inbox.',
        'parameters': _object({
            'taskId': UUID,
            'expectedVersion': VERSION,
            'workspaceId': {'anyOf': [UUID, {'type': 'null'}]},
            'expectedSourceOrderVersion': VERSION,
            'expectedDestinationOrderVersion': VERSION,
        }, ['taskId', 'expectedVersion', 'workspaceId']),
    },
    {
        'name': 'home_archive_task',
        'description': 'Archive exactly one task only when explicitly requested. This is reversible soft-state; use the exact task ID and version.',
        'parameters': _object({
            'taskId': UUID,
            'expectedVersion': VERSION,
            'expectedOrderVersion': VERSION,
        }, ['taskId', 'expectedVersion']),
    },
    {
        'name': 'home_search_workspaces',
        'description': 'Search active workspace metadata visible in the current Home conversation scope. Results never include roots or files; do not treat a search result as permission to act.',
        'parameters': _object({
            'query': _string(2, 120),
            'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20},
        }, ['query']),
    },
    {
        'name': 'home_reuse_workspace',
        'description': 'Select one exact active owner workspace by ID for this turn only when the user asks to organize a task there. This does not change the conversation scope.',
        'parameters': _object({'workspaceId': UUID}, ['workspaceId']),
    },
    {
        'name': 'home_create_workspace',
        'description': 'Create exactly one rootless planning workspace only when the user explicitly asks for it. Available in Home-scoped conversations only.',
        'parameters': _object({'name': TITLE, 'objective': OBJECTIVE}, ['name']),
    },
    {
        'name': 'home_update_workspace_objective',
        'description': 'Update one active workspace objective only when the user explicitly requests that change. Use the exact workspace ID and version.',
        'parameters': _object({
            'workspaceId': UUID,
            'expectedVersion': VERSION,
            'objective': OBJECTIVE,
        }, ['workspaceId', 'expectedVersion', 'objective']),
    },
    {
        'name': 'home_undo_action',
        'description': 'Undo exactly one eligible owner action receipt only when the user explicitly asks to undo that action. Never undo child actions or multiple receipts.',
        'parameters': _object({'actionId': UUID}, ['actionId']),
    },
    {
        'name': 'home_propose_bulk_changes',
        'description': 'Save a multi-item assistant-proposed task/workspace change as an editable review draft. This does not execute any item; the user must later edit or explicitly accept it in Home.',
        'parameters': _object({
            'items': {
                'type': 'array',
                'minItems': 2,
                'maxItems': 20,
                'items': {
                    'anyOf': [
                        _bulk_create_task_schema(),
                        _update_task_schema('task.update'),
                        _bulk_task_move_schema(),
                        _bulk_task_archive_schema(),
                        _bulk_workspace_create_schema(),
                        _bulk_workspace_update_schema(),
                    ]
                },
            },
        }, ['items']),
    },
)

HOME_TOOL_NAMES = tuple(definition['name'] for definition in HOME_TOOL_DEFINITIONS)
