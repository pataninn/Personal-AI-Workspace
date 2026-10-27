import type { IStorageQuotaRepository } from '@/modules/storage-quotas/repositories/storage-quota-repository';

export interface StorageUsageDto {
  readonly state: 'reconciling' | 'ready' | 'unavailable';
  readonly unit: 'bytes';
  readonly unitSystem: 'decimal-si';
  readonly usedBytes: string | null;
  readonly reservedBytes: string | null;
  readonly limitBytes: string | null;
  readonly availableBytes: string | null;
  readonly overLimit: boolean | null;
  readonly asOf: string | null;
}

export class GetStorageUsage {
  public constructor(private readonly storage: IStorageQuotaRepository) {}

  public async execute(ownerId: string): Promise<StorageUsageDto> {
    const snapshot = await this.storage.readUsage(ownerId);
    return {
      state: snapshot.state,
      unit: 'bytes',
      unitSystem: 'decimal-si',
      usedBytes: snapshot.usedBytes?.toString() ?? null,
      reservedBytes: snapshot.reservedBytes?.toString() ?? null,
      limitBytes: snapshot.limitBytes?.toString() ?? null,
      availableBytes: snapshot.availableBytes?.toString() ?? null,
      overLimit: snapshot.overLimit,
      asOf: snapshot.asOf?.toISOString() ?? null
    };
  }
}
