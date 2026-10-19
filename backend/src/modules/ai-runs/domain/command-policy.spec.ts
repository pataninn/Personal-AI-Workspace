import { normalizeCommandProposal, normalizePolicyHermesPermission, summarizeArgument } from '@/modules/ai-runs/domain/command-policy';

describe('sandbox command policy', () => {
  it('allows bounded read-only commands but denies every option in the MVP1 grammar', () => {
    const proposal = normalizeCommandProposal({ command: 'rg', args: ['TODO', 'src'] });
    expect(proposal.classification).toBe('safe');
    expect(proposal.limits.network).toBe('denied');

    const preCommand = normalizeCommandProposal({ command: 'rg', args: ['--pre', 'helper', 'src'] });
    expect(preCommand.classification).toBe('blocked');
    expect(preCommand.blockedReason).toBe('shell_composition_denied');
  });

  it('blocks host, shell, secret, and network-shaped proposals', () => {
    expect(normalizeCommandProposal({ command: 'powershell', args: ['Get-ChildItem'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['TODO', '../../outside'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['API_KEY=secret'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['AWS_ACCESS_KEY_ID=secret'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['FOO=bar'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['prefix C:\\Users\\person\\workspace\\src'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['path=/workspace/project/src'] }).classification).toBe('blocked');
    expect(normalizeCommandProposal({ command: 'rg', args: ['GCP_SERVICE_ACCOUNT_KEY=leak'] }).classification).toBe('blocked');
  });

  it('redacts sensitive argument summaries and summaries', () => {
    expect(summarizeArgument('AWS_ACCESS_KEY_ID=secret')).toBe('[redacted path]');
    expect(summarizeArgument('FOO=bar')).toBe('[redacted path]');
    expect(summarizeArgument('prefix C:\\Users\\person\\workspace\\src')).toBe('[redacted path]');
    expect(summarizeArgument('GCP_SERVICE_ACCOUNT_KEY=leak')).toBe('[redacted path]');
    expect(summarizeArgument('C:\\Users\\person\\workspace\\.env')).toBe('[redacted path]');
    expect(normalizeCommandProposal({ command: 'rg', args: [], summary: 'API_KEY=secret-value' }).summary).toContain('redacted');
  });

  it('rejects malformed proposal fields before policy classification', () => {
    expect(() => normalizeCommandProposal({ command: 'rg', args: ['ok', '\u0000'] })).toThrow('invalid');
    expect(() => normalizeCommandProposal({ command: 'rg', args: 'src' })).toThrow('at most 32');
  });

  it('accepts only simple read commands against exact selected manifest paths', () => {
    const selected = ['src/main.ts', 'README.md'];
    expect(normalizePolicyHermesPermission({ command: 'hermes-terminal', args: ['cat src/main.ts'] }, selected, 'a'.repeat(64))).toMatchObject({ classification: 'safe', command: 'hermes-terminal', args: ['cat src/main.ts'], limits: { network: 'denied', maxOutputBytes: 32768 } });
    expect(normalizePolicyHermesPermission({ command: 'hermes-terminal', args: ['rg TODO src/main.ts'] }, selected, 'a'.repeat(64)).classification).toBe('safe');
  });

  it('blocks shell composition, options, sensitive commands, and non-selected paths', () => {
    const selected = ['src/main.ts'];
    for (const command of ['cat .env', 'cat ../outside', 'cat src/other.ts', 'cat src/main.ts; pwd', 'cat "src/main.ts"', 'cat --help', 'npm install package', 'rg x $(pwd)']) {
      expect(normalizePolicyHermesPermission({ command: 'hermes-terminal', args: [command] }, selected, 'b'.repeat(64)).classification).toBe('blocked');
    }
  });
});
