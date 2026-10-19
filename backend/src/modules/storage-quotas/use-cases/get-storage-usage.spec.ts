import type { IStorageQuotaRepository } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';

describe('GetStorageUsage', () => {
  it('returns exact byte strings and decimal presentation metadata', async () => {
    const repository = {
      readUsage: jest.fn().mockResolvedValue({
        state: 'ready', usedBytes: 1234n, reservedBytes: 200n, limitBytes: 5_000_000_000n,
        availableBytes: 4_999_998_566n, overLimit: false, asOf: new Date('2026-10-19T00:00:00.000Z')
      })
    } as unknown as IStorageQuotaRepository;

    await expect(new GetStorageUsage(repository).execute('owner-1')).resolves.toEqual({
      state: 'ready', unit: 'bytes', unitSystem: 'decimal-si', usedBytes: '1234', reservedBytes: '200',
      limitBytes: '5000000000', availableBytes: '4999998566', overLimit: false, asOf: '2026-10-19T00:00:00.000Z'
    });
    expect(repository.readUsage).toHaveBeenCalledWith('owner-1');
  });

  it('does not present unverified usage as zero', async () => {
    const repository = {
      readUsage: jest.fn().mockResolvedValue({
        state: 'reconciling', usedBytes: null, reservedBytes: null, limitBytes: null,
        availableBytes: null, overLimit: null, asOf: null
      })
    } as unknown as IStorageQuotaRepository;

    await expect(new GetStorageUsage(repository).execute('owner-1')).resolves.toMatchObject({
      state: 'reconciling', usedBytes: null, reservedBytes: null, availableBytes: null, overLimit: null, asOf: null
    });
  });
});
