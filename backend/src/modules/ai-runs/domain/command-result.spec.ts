import { COMMAND_LIMITS } from '@/modules/ai-runs/domain/command-policy';
import { sanitizeCommandResult } from '@/modules/ai-runs/domain/command-result';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';

describe('sandbox command result sanitization', () => {
  it('redacts case-insensitive generic environment assignments in output previews', () => {
    const result: CommandResult = {
      exitCode: 0,
      termination: 'completed',
      durationMs: 1,
      outputBytes: 64,
      outputLineCount: 1,
      outputTruncated: false,
      outputSha256: 'a'.repeat(64),
      outputPreview: 'foo=bar Foo = "mixed-value" fOo=third-value'
    };

    const sanitized = sanitizeCommandResult(result, COMMAND_LIMITS);

    expect(sanitized.outputPreview).not.toContain('bar');
    expect(sanitized.outputPreview).not.toContain('mixed-value');
    expect(sanitized.outputPreview).not.toContain('third-value');
    expect(sanitized.outputPreview).toContain('[REDACTED]');
  });
});
