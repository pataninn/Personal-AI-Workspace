import { parseStartTicks, probeWorkspaceExportBuilder } from '@/infrastructure/workspace-export-process-identity';

const IDENTITY = { processId: 91, startTicks: '987654321' };

function processStat(startTicks: string): string {
  const remaining = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), startTicks];
  return `91 (process name with ) inside) ${remaining.join(' ')}`;
}

describe('workspace export builder identity', () => {
  it('reads start ticks after the final command-name delimiter', () => {
    expect(parseStartTicks(processStat(IDENTITY.startTicks))).toBe(IDENTITY.startTicks);
  });

  it('distinguishes a live builder from an absent or reused PID', async () => {
    await expect(probeWorkspaceExportBuilder(IDENTITY, async () => processStat(IDENTITY.startTicks))).resolves.toBe('active');
    await expect(probeWorkspaceExportBuilder(IDENTITY, async () => processStat('123'))).resolves.toBe('reused');
    await expect(probeWorkspaceExportBuilder(IDENTITY, async () => { throw withCode('ENOENT'); })).resolves.toBe('absent');
  });

  it('keeps permission and malformed-stat uncertainty pending', async () => {
    await expect(probeWorkspaceExportBuilder(IDENTITY, async () => { throw withCode('EACCES'); })).resolves.toBe('unknown');
    await expect(probeWorkspaceExportBuilder(IDENTITY, async () => 'not a proc stat')).resolves.toBe('unknown');
  });
});

function withCode(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
