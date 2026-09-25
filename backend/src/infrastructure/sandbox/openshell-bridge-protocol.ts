import {
  MAX_BRIDGE_CONTROL_FRAME_BYTES,
  MAX_BRIDGE_INPUT_CHUNK_BYTES,
  OpenShellBridgeProtocolError,
  type BridgeFrame
} from '@/infrastructure/sandbox/openshell-bridge-types';
import { parseBridgeFrame, validateBridgeFrame } from '@/infrastructure/sandbox/openshell-bridge-protocol-validation';

export { OpenShellBridgeProtocolError } from '@/infrastructure/sandbox/openshell-bridge-types';
export {
  OPEN_SHELL_BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_CONTROL_FRAME_BYTES,
  MAX_BRIDGE_INPUT_CHUNK_BYTES,
  MAX_BRIDGE_DEADLINE_MS,
  type BridgeAcpSendPayload,
  type BridgeCreatePayload,
  type BridgeExecPayload,
  type BridgeFrame,
  type BridgeJsonObject,
  type BridgeJsonValue,
  type BridgeOperation,
  type BridgeOutcome,
  type BridgeProbePayload,
  type BridgeRequestFrame,
  type BridgeResponseFrame,
  type BridgeUploadPayload
} from '@/infrastructure/sandbox/openshell-bridge-types';

export function encodeBridgeFrame(frame: BridgeFrame): Buffer {
  validateBridgeFrame(frame);
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(frame), 'utf8');
  } catch {
    throw new OpenShellBridgeProtocolError('The bridge frame could not be encoded.');
  }
  if (body.byteLength > MAX_BRIDGE_CONTROL_FRAME_BYTES) {
    throw new OpenShellBridgeProtocolError('The bridge frame exceeds the configured byte limit.');
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

export function decodeBridgeFrame(body: Buffer, nowEpochMs = Date.now()): BridgeFrame {
  if (body.byteLength > MAX_BRIDGE_CONTROL_FRAME_BYTES) {
    throw new OpenShellBridgeProtocolError('The bridge frame exceeds the configured byte limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new OpenShellBridgeProtocolError('The bridge frame is not valid JSON.');
  }
  return parseBridgeFrame(value, nowEpochMs);
}

export class BridgeFrameDecoder {
  private pending = Buffer.alloc(0);

  public push(chunk: Buffer, nowEpochMs = Date.now()): readonly BridgeFrame[] {
    if (chunk.byteLength > MAX_BRIDGE_INPUT_CHUNK_BYTES) {
      throw new OpenShellBridgeProtocolError('The bridge input chunk exceeds the configured byte limit.');
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: BridgeFrame[] = [];
    while (this.pending.byteLength >= 4) {
      const bodyLength = this.pending.readUInt32BE(0);
      if (bodyLength > MAX_BRIDGE_CONTROL_FRAME_BYTES) {
        throw new OpenShellBridgeProtocolError('The bridge frame length exceeds the configured byte limit.');
      }
      if (this.pending.byteLength < bodyLength + 4) {
        break;
      }
      frames.push(decodeBridgeFrame(this.pending.subarray(4, bodyLength + 4), nowEpochMs));
      this.pending = this.pending.subarray(bodyLength + 4);
    }
    return frames;
  }

  public assertComplete(): void {
    if (this.pending.byteLength > 0) {
      throw new OpenShellBridgeProtocolError('The bridge connection ended with a partial frame.');
    }
  }
}
