import { ModelProviderOutputError } from '@/modules/ai-runs/domain/model-provider-errors';
import { parseProviderOutput } from '@/infrastructure/ai-provider/provider-output';

describe('parseProviderOutput', () => {
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
      changes: []
    });
  });
});
