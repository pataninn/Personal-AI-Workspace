import document from '../../openapi.json';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OpenAPI object.');
  return value as JsonRecord;
}

describe('automation OpenAPI contract', () => {
  it('documents owner-scoped schedule, Run now, and bounded history operations', () => {
    const paths = record(document.paths);
    const schedules = record(paths['/api/v1/automations/schedules']);
    const update = record(record(paths['/api/v1/automations/schedules/{scheduleId}']).patch);
    const run = record(record(paths['/api/v1/automations/schedules/{scheduleId}/runs']).post);
    const history = record(record(paths['/api/v1/automations/schedules/{scheduleId}/occurrences']).get);

    expect(record(schedules.get).operationId).toBe('listAutomationSchedules');
    expect(record(schedules.post).operationId).toBe('createAutomationSchedule');
    expect(update.operationId).toBe('updateAutomationSchedule');
    expect(run.operationId).toBe('runAutomationNow');
    expect(history.operationId).toBe('listAutomationOccurrences');
    expect(run.security).toEqual([{ sessionCookie: [] }]);
    expect(run.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
    ]));
    expect(Array.isArray(document.tags) && document.tags.some((tag) => record(tag).name === 'Account administration')).toBe(true);
  });

  it('documents bounded source revisions and historical provider usage on each occurrence', () => {
    const schemas = record(record(document.components).schemas);
    const occurrence = record(schemas.AutomationOccurrence);
    const properties = record(occurrence.properties);
    const taskSources = record(properties.taskSources);
    const providerUsage = record(properties.providerUsage);

    expect(taskSources.maxItems).toBe(256);
    expect(record(taskSources.items).required).toEqual(['taskId', 'revision', 'available', 'title', 'href']);
    expect(record(providerUsage.properties).state).toEqual(expect.objectContaining({ enum: ['not_started', 'settled', 'pending', 'unknown'] }));
    expect(record(record(providerUsage.properties).calls).maxItems).toBe(32);
  });
});
