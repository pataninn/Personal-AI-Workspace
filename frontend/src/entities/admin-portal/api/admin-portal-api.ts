import { getJson, patchJson, postJson, requestJson } from '@/shared/api';
import type { AdminAccountSummary, AdminAuditEvent, AdminDemoSettings, AdminDemoSettingsUpdate } from '@/entities/admin-portal/model/types';

export async function getAdminAccounts(search: string): Promise<readonly AdminAccountSummary[]> {
  return (await getJson<{ accounts: readonly AdminAccountSummary[] }>(`/api/v1/admin/accounts?search=${encodeURIComponent(search)}`)).accounts;
}

export function createAdminAccount(csrfToken: string, input: { readonly displayName: string; readonly identifier: string; readonly password: string }): Promise<unknown> {
  return postJson('/api/v1/admin/accounts', input, { 'X-CSRF-Token': csrfToken });
}

export function updateAdminAccountLimits(csrfToken: string, accountId: string, input: {
  readonly expectedRevision: number; readonly dailyCreditLimitUnits: string | null; readonly lifetimeCreditLimitUnits: string | null; readonly storageLimitBytes: string | null;
}): Promise<unknown> {
  return patchJson(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/limits`, input, { 'X-CSRF-Token': csrfToken });
}

export function setAdminAccountEnabled(csrfToken: string, accountId: string, enabled: boolean): Promise<unknown> {
  return patchJson(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/status`, { enabled }, { 'X-CSRF-Token': csrfToken });
}

export function resetAdminAccountPassword(csrfToken: string, accountId: string, password: string): Promise<unknown> {
  return postJson(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/password-resets`, { password }, { 'X-CSRF-Token': csrfToken });
}

export function revokeAdminAccountSessions(csrfToken: string, accountId: string): Promise<unknown> {
  return postJson(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/session-revocations`, {}, { 'X-CSRF-Token': csrfToken });
}

export function getAdminDemoSettings(): Promise<AdminDemoSettings> {
  return getJson('/api/v1/admin/demo-settings');
}

export function saveAdminDemoSettings(csrfToken: string, input: AdminDemoSettingsUpdate): Promise<AdminDemoSettings> {
  return requestJson('/api/v1/admin/demo-settings', { method: 'PUT', body: input, headers: { 'X-CSRF-Token': csrfToken } });
}

export async function getAdminAudit(): Promise<readonly AdminAuditEvent[]> {
  return (await getJson<{ events: readonly AdminAuditEvent[] }>('/api/v1/admin/audit?limit=40')).events;
}
