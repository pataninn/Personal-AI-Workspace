import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import { hashText, toEgressProjectFact } from '@/modules/ai-runs/use-cases/manifest-builder';

describe('project fact disclosure snapshot', () => {
  it('hashes and sizes the exact redacted payload rather than exposing a raw-value hash', () => {
    const rawContent = 'token=private-value\nUse pnpm test.';
    const fact: ProjectFact = {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      key: 'preferred command',
      title: 'Preferred command',
      content: rawContent,
      source: { kind: 'user', label: 'Added by you', reference: null },
      version: 1,
      verifiedAt: null,
      verificationStatus: 'needs_review',
      createdAt: new Date('2026-09-26T00:00:00.000Z'),
      updatedAt: new Date('2026-09-26T00:00:00.000Z')
    };

    const snapshot = toEgressProjectFact(fact);
    const disclosedValue = JSON.stringify({ title: snapshot.title, content: snapshot.content, source: snapshot.source.label });

    expect(snapshot.content).toBe('token=[REDACTED]\nUse pnpm test.');
    expect(snapshot.sizeBytes).toBe(Buffer.byteLength(disclosedValue, 'utf8'));
    expect(snapshot.sourceHash).toBe(hashText(disclosedValue));
    expect(snapshot.sourceHash).not.toBe(hashText(rawContent));
  });
});
