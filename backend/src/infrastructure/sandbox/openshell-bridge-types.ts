import { AppError } from '@/shared/errors/app-error';

export const OPEN_SHELL_BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_BRIDGE_INPUT_CHUNK_BYTES = 1024 * 1024;
export const MAX_BRIDGE_DEADLINE_MS = 5 * 60 * 1000;

export type BridgeOperation =
  | 'probe'
  | 'create'
  | 'upload'
  | 'exec'
  | 'acp.open'
  | 'acp.send'
  | 'acp.cancel'
  | 'status'
  | 'delete';

export type BridgeOutcome = 'ok' | 'unavailable' | 'rejected' | 'unknown' | 'review_required';

export type BridgeJsonValue = string | number | boolean | null | BridgeJsonObject | readonly BridgeJsonValue[];

export interface BridgeJsonObject {
  readonly [key: string]: BridgeJsonValue;
}

export interface BridgeRequestFrame {
  readonly kind: 'request';
  readonly protocolVersion: number;
  readonly operation: BridgeOperation;
  readonly runId: string;
  readonly requestId: number;
  readonly deadlineEpochMs: number;
  readonly capability: string;
  readonly payload: BridgeJsonObject;
}

export interface BridgeResponseFrame {
  readonly kind: 'response';
  readonly protocolVersion: number;
  readonly operation: BridgeOperation;
  readonly runId: string;
  readonly requestId: number;
  readonly bridgeSequence: number;
  readonly outcome: BridgeOutcome;
  readonly receiptDigest: string;
  readonly payload: BridgeJsonObject;
  readonly errorCode?: string;
}

export type BridgeFrame = BridgeRequestFrame | BridgeResponseFrame;

export interface BridgeProbePayload extends BridgeJsonObject {
  readonly profileDigest: string;
}

export interface BridgeCreatePayload extends BridgeJsonObject {
  readonly manifestDigest: string;
  readonly profileDigest: string;
}

export interface BridgeUploadPayload extends BridgeJsonObject {
  readonly manifestDigest: string;
  readonly archiveBytes: number;
  readonly remoteDestination: string;
}

export interface BridgeExecPayload extends BridgeJsonObject {
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

export interface BridgeAcpSendPayload extends BridgeJsonObject {
  readonly frame: BridgeJsonObject;
}

export class OpenShellBridgeProtocolError extends AppError {
  public constructor(message: string) {
    super('OPEN_SHELL_BRIDGE_PROTOCOL_INVALID', 503, message);
    this.name = 'OpenShellBridgeProtocolError';
  }
}
