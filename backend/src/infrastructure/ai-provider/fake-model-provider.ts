import type {
  IModelProvider,
  ModelProviderEvent,
  ModelProviderRequest,
  ProviderCancellationResult
} from '@/modules/ai-runs/repositories/model-provider';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import { ModelProviderOutputError } from '@/modules/ai-runs/domain/model-provider-errors';
import { parseProviderOutput } from '@/infrastructure/ai-provider/provider-output';

export interface FakeModelProviderOptions {
  readonly response?: string;
  readonly delayMs?: number;
  readonly proposedChanges?: readonly RuntimeChangeProposal[];
}

export class FakeModelProvider implements IModelProvider {
  public readonly requests: ModelProviderRequest[] = [];
  public readonly cancelledRuns: string[] = [];
  public options: FakeModelProviderOptions = {};
  private readonly cancelled = new Set<string>();

  public async checkAvailability(): Promise<void> {
    return Promise.resolve();
  }

  public async *stream(input: ModelProviderRequest): AsyncIterable<ModelProviderEvent> {
    this.requests.push(input);
    yield { type: 'started' };
    const configuredResponse = this.options.response ?? `Fake response for: ${input.request}`;
    let parsed: ReturnType<typeof parseProviderOutput>;
    try {
      parsed = parseProviderOutput(configuredResponse);
    } catch (error: unknown) {
      yield { type: 'failed', message: error instanceof ModelProviderOutputError ? error.message : 'The fake provider returned an invalid response.' };
      return;
    }
    const changes = [...(this.options.proposedChanges ?? []), ...parsed.changes];
    if (changes.length > 0) {
      yield { type: 'changes.proposed', changes };
    }
    const response = parsed.text;
    for (const chunk of chunks(response, 32)) {
      await wait(this.options.delayMs ?? 0);
      if (this.cancelled.has(input.runId)) {
        yield { type: 'cancelled' };
        return;
      }
      yield { type: 'assistant.delta', text: chunk };
    }
    if (this.cancelled.has(input.runId)) {
      yield { type: 'cancelled' };
      return;
    }
    if (response.length > 0) {
      yield { type: 'assistant.message.completed', text: response };
    }
    yield { type: 'completed', text: response };
  }

  public async cancel(runId: string): Promise<ProviderCancellationResult> {
    this.cancelled.add(runId);
    this.cancelledRuns.push(runId);
    return { outcome: 'confirmed' };
  }
}

function chunks(value: string, size: number): readonly string[] {
  const result: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    result.push(value.slice(offset, offset + size));
  }
  return result;
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
