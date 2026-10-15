import { afterEach, describe, expect, it } from 'vitest';

import { clearTaskReceiptPointer, readTaskReceiptPointer, saveTaskReceiptPointer } from '@/features/task-actions/model/task-action-receipt-pointer';

const ACTION_ID = '33333333-3333-4333-8333-333333333333';

describe('task action receipt pointer', () => {
  afterEach(() => { globalThis.sessionStorage.clear(); });

  it('stores only a valid receipt ID under the current owner and task', () => {
    saveTaskReceiptPointer('owner-1', 'task-1', ACTION_ID);
    expect(readTaskReceiptPointer('owner-1', 'task-1')).toBe(ACTION_ID);
    expect(readTaskReceiptPointer('owner-2', 'task-1')).toBeNull();
  });

  it('discards malformed pointers instead of using them as a receipt route', () => {
    globalThis.sessionStorage.setItem('personal-ai:task-action-receipt:owner-1:task-1', 'not-an-action-id');
    expect(readTaskReceiptPointer('owner-1', 'task-1')).toBeNull();
    expect(globalThis.sessionStorage.getItem('personal-ai:task-action-receipt:owner-1:task-1')).toBeNull();
  });

  it('removes a pointer after the task view no longer owns it', () => {
    saveTaskReceiptPointer('owner-1', 'task-1', ACTION_ID);
    clearTaskReceiptPointer('owner-1', 'task-1');
    expect(readTaskReceiptPointer('owner-1', 'task-1')).toBeNull();
  });
});
