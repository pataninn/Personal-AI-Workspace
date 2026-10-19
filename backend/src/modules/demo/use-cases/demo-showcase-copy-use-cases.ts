import type { DemoShowcaseCopyDto, IDemoShowcaseCopyManager } from '@/modules/demo/domain/demo-showcase-copy-types';

export class GetDemoShowcaseCopyStatusUseCase {
  public constructor(private readonly copies: IDemoShowcaseCopyManager) {}
  public execute(ownerId: string): Promise<DemoShowcaseCopyDto> { return this.copies.getStatus(ownerId); }
}

export class RetryDemoShowcaseCopyUseCase {
  public constructor(private readonly copies: IDemoShowcaseCopyManager) {}
  public execute(ownerId: string): Promise<DemoShowcaseCopyDto> { return this.copies.retry(ownerId); }
}
