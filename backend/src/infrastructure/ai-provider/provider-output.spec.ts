import { ModelProviderOutputError } from '@/modules/ai-runs/domain/model-provider-errors';
import { parseProviderOutput } from '@/infrastructure/ai-provider/provider-output';

describe('parseProviderOutput', () => {
  it.each([
    ['introductory prose', 'I will create a simple README.md file for you.\n', ''],
    ['Markdown fence', '```json\n', '\n```'],
    ['prose and a fence', 'Here are the changes.\n```json\n', '\n```\nReady.']
  ])('recognizes executable changes wrapped in %s', (_label, prefix, suffix) => {
    const content = '# Project\n\n## Overview\n\nBrief description of the project goes here.\n';
    const result = parseProviderOutput(`${prefix}${JSON.stringify({
      message: 'Created README.md.',
      changes: [{ operation: 'create', path: 'README.md', content }]
    })}${suffix}`);

    expect(result).toEqual({ text: 'Created README.md.', changes: [{ operation: 'create', path: 'README.md', content }], taskSuggestions: [] });
  });

  it('preserves quoted braces, escapes, and nested JSON in file content', () => {
    const content = '{"message":"a } brace, a \\\"quote\\\", and a \\\\slash"}\n';
    const result = parseProviderOutput(`Creating the file.\n${JSON.stringify({
      changes: [{ operation: 'create', path: 'example.json', content }]
    })}`);
    expect(result.changes[0]?.content).toBe(content);
  });

  it.each([
    'Done. {"changes":[{"operation":"create","path":"README.md","content":"unfinished',
    'Done. {"changes":[{"operation":"create"}]}',
    'Done. {"changes":[]} {"changes":[]}',
    'Done. {"changes":[],"unexpected":true}',
    `Done. ${JSON.stringify({ changes: [{ operation: 'create', path: 'README.md', content: 'NVIDIA_API_KEY=secret-value' }] })}`
  ])('rejects invalid wrapped contracts rather than claiming success: %s', (text) => {
    expect(() => parseProviderOutput(text)).toThrow(ModelProviderOutputError);
  });

  it('keeps ordinary braces and unrelated JSON as chat text', () => {
    const text = 'Use {name} in templates. The example data is {"name":"project"}.';
    expect(parseProviderOutput(text)).toEqual({ text, changes: [], taskSuggestions: [] });
  });

  it('accepts bounded assistant text and structured changes', () => {
    const result = parseProviderOutput(JSON.stringify({
      message: 'I updated the greeting.',
      changes: [{ operation: 'edit', path: 'src/index.ts', content: 'export const greeting = "hello";' }]
    }));

    expect(result.text).toBe('I updated the greeting.');
    expect(result.changes).toEqual([{ operation: 'edit', path: 'src/index.ts', content: 'export const greeting = "hello";' }]);
  });

  it('accepts the provider operation alias from a live NIM response', () => {
    const result = parseProviderOutput(JSON.stringify({
      message: 'Updated greeting.',
      changes: [{ type: 'edit', path: 'src/app.ts', content: "export const greeting = 'Hello, workspace!';" }]
    }));
    expect(result.changes).toEqual([{ operation: 'edit', path: 'src/app.ts', content: "export const greeting = 'Hello, workspace!';" }]);
  });

  it('normalizes kind and new fields seen in a streamed NIM response', () => {
    const result = parseProviderOutput(JSON.stringify({
      message: 'Updated greeting.',
      changes: [{ kind: 'edit', path: 'src/app.ts', old: "export const greeting = 'Hello';", new: "export const greeting = 'Hello, workspace!';" }]
    }));
    expect(result.changes).toEqual([{ operation: 'edit', path: 'src/app.ts', content: "export const greeting = 'Hello, workspace!';" }]);
  });

  it('rejects malformed or secret-bearing structured output', () => {
    expect(() => parseProviderOutput('{"changes":[{"operation":"edit"}]}')).toThrow(ModelProviderOutputError);
    expect(() => parseProviderOutput(JSON.stringify({
      message: 'bad',
      changes: [{ operation: 'edit', path: 'src/index.ts', content: 'NVIDIA_API_KEY=secret-value' }]
    }))).toThrow(ModelProviderOutputError);
  });

  it('keeps plain text responses usable without treating braces as a contract', () => {
    expect(parseProviderOutput('Use the existing project conventions.')).toEqual({
      text: 'Use the existing project conventions.',
      changes: [],
      taskSuggestions: []
    });
  });

  it('normalizes bounded task drafts without turning them into task mutations', () => {
    const result = parseProviderOutput(JSON.stringify({
      message: 'Here are two ideas.',
      taskSuggestions: [
        { title: '  Update setup notes  ', details: '  Document the startup steps.  ' },
        { title: 'Check tests' }
      ]
    }));

    expect(result.taskSuggestions).toEqual([
      { title: 'Update setup notes', details: 'Document the startup steps.' },
      { title: 'Check tests', details: null }
    ]);
    expect(result.changes).toEqual([]);
  });

  it('rejects oversized, secret-bearing, or malformed task drafts', () => {
    expect(() => parseProviderOutput(JSON.stringify({ taskSuggestions: Array.from({ length: 6 }, (_, index) => ({ title: `Task ${index}` })) }))).toThrow(ModelProviderOutputError);
    expect(() => parseProviderOutput(JSON.stringify({ taskSuggestions: [{ title: 'NVIDIA_API_KEY=secret-value' }] }))).toThrow(ModelProviderOutputError);
    expect(() => parseProviderOutput(JSON.stringify({ taskSuggestions: [{ title: 'ok', details: 'x'.repeat(4097) }] }))).toThrow(ModelProviderOutputError);
    expect(() => parseProviderOutput(JSON.stringify({ taskSuggestions: [{ title: 'ok', status: 'accepted' }] }))).toThrow(ModelProviderOutputError);
  });
});
