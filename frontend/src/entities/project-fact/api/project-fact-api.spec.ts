import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { createProjectFact, deleteProjectFact, listProjectFacts, updateProjectFact, verifyProjectFact } from '@/entities/project-fact/api/project-fact-api';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FACT_ID = '55555555-5555-4555-8555-000000000001';
const fact = {
  id: FACT_ID,
  projectId: PROJECT_ID,
  title: 'Preferred language',
  content: 'This project uses TypeScript.',
  source: { kind: 'user', label: 'Added by you', reference: null },
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  version: 1,
  verifiedAt: null,
  verificationStatus: 'needs_review'
};

const fetchMock = vi.fn<typeof fetch>();

describe('project fact API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads facts from the requested project and rejects cross-project response data', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ facts: [fact] }));

    await expect(listProjectFacts(PROJECT_ID)).resolves.toEqual([fact]);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/projects/${PROJECT_ID}/facts`, expect.objectContaining({ method: 'GET', credentials: 'include' }));

    fetchMock.mockResolvedValueOnce(envelope({ facts: [{ ...fact, projectId: '22222222-2222-4222-8222-222222222222' }] }));
    await expect(listProjectFacts(PROJECT_ID)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('creates a fact using server-owned source attribution', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ fact }));

    await expect(createProjectFact(PROJECT_ID, { title: fact.title, content: fact.content }, 'csrf-token')).resolves.toEqual(fact);
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestInit?.method).toBe('POST');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ title: fact.title, content: fact.content });
    expect(new Headers(requestInit?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('sends version preconditions for edits and reviews', async () => {
    const updatedFact = { ...fact, version: 2, updatedAt: '2026-09-26T00:01:00.000Z' };
    fetchMock.mockResolvedValueOnce(envelope({ fact: updatedFact }));
    await expect(updateProjectFact(PROJECT_ID, FACT_ID, { title: fact.title, content: fact.content }, 1, 'csrf-token')).resolves.toEqual(updatedFact);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: fact.title, content: fact.content, expectedVersion: 1 });

    const reviewedFact = { ...updatedFact, version: 3, verifiedAt: '2026-09-26T00:02:00.000Z', verificationStatus: 'verified' as const };
    fetchMock.mockResolvedValueOnce(envelope({ fact: reviewedFact }));
    await expect(verifyProjectFact(PROJECT_ID, FACT_ID, 2, 'csrf-token')).resolves.toEqual(reviewedFact);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/projects/${PROJECT_ID}/facts/${FACT_ID}/verification`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedVersion: 2 });
  });

  it('uses a version checked delete and accepts the 204 response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(deleteProjectFact(PROJECT_ID, FACT_ID, 4, 'csrf-token')).resolves.toBeUndefined();
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestInit?.method).toBe('DELETE');
    expect(new Headers(requestInit?.headers).get('If-Match')).toBe('"4"');
    expect(new Headers(requestInit?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
