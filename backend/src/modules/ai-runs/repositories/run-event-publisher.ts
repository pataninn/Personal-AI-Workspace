export type RunEventType =
  | 'run.snapshot'
  | 'run.started'
  | 'run.status_changed'
  | 'assistant.delta'
  | 'assistant.message.completed'
  | 'tool.proposed'
  | 'approval.required'
  | 'approval.decided'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'run.completed'
  | 'run.failed'
  | 'run.blocked'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.needs_manual_review';

export interface RunEvent {
  readonly runId: string;
  readonly type: RunEventType;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PublishRunEventInput {
  readonly runId: string;
  readonly type: RunEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type RunEventListener = (event: RunEvent) => void;

export interface IRunEventPublisher {
  publish(input: PublishRunEventInput): RunEvent;
  subscribe(runId: string, listener: RunEventListener): () => void;
}
