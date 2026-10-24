import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import {
  getAdminAccounts, getAdminAudit, getAdminDemoSettings, resetAdminAccountPassword,
  revokeAdminAccountSessions, saveAdminDemoSettings, setAdminAccountEnabled, updateAdminAccountLimits
} from '@/entities/admin-portal';
import type { AdminAccountSummary, AdminAuditEvent, AdminDemoSettings } from '@/entities/admin-portal';
import { selectCsrfToken, selectPrincipal } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import {
  Alert, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle,
  Button, Card, DialogContent, DialogDescription, DialogRoot, DialogTitle, Input, Label, Skeleton
} from '@/shared/ui';

interface AdminState {
  readonly accounts: 'loading' | 'success' | 'error';
  readonly settings: 'loading' | 'success' | 'error';
  readonly audit: 'loading' | 'success' | 'error';
}

type ConfirmAction = { readonly account: AdminAccountSummary; readonly action: 'disable' | 'enable' | 'revoke' } | null;

export function AdminPortalPage(): React.JSX.Element {
  const principal = useAppSelector(selectPrincipal);
  const csrfToken = useAppSelector(selectCsrfToken);
  const [accounts, setAccounts] = useState<readonly AdminAccountSummary[]>([]);
  const [settings, setSettings] = useState<AdminDemoSettings | null>(null);
  const [audit, setAudit] = useState<readonly AdminAuditEvent[]>([]);
  const [loadState, setLoadState] = useState<AdminState>({ accounts: 'loading', settings: 'loading', audit: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  useEffect(() => {
    let active = true;
    setLoadState({ accounts: 'loading', settings: 'loading', audit: 'loading' });
    void Promise.allSettled([getAdminAccounts(appliedSearch), getAdminDemoSettings(), getAdminAudit()]).then((results) => {
      if (!active) return;
      const [accountResult, settingsResult, auditResult] = results;
      if (accountResult.status === 'fulfilled') { setAccounts(accountResult.value); setLoadState((current) => ({ ...current, accounts: 'success' })); }
      else setLoadState((current) => ({ ...current, accounts: 'error' }));
      if (settingsResult.status === 'fulfilled') { setSettings(settingsResult.value); setLoadState((current) => ({ ...current, settings: 'success' })); }
      else setLoadState((current) => ({ ...current, settings: 'error' }));
      if (auditResult.status === 'fulfilled') { setAudit(auditResult.value); setLoadState((current) => ({ ...current, audit: 'success' })); }
      else setLoadState((current) => ({ ...current, audit: 'error' }));
    });
    return () => { active = false; };
  }, [appliedSearch, refreshKey]);

  if (principal?.role !== 'admin' || principal.accountKind !== 'regular') return <Navigate to="/dashboard" replace />;

  async function runAction(action: () => Promise<unknown>, success: string): Promise<boolean> {
    if (!csrfToken) { setError('Your security token is unavailable. Refresh your session and try again.'); return false; }
    setError(null); setNotice(null);
    try {
      await action();
      setNotice(success);
      setRefreshKey((key) => key + 1);
      return true;
    } catch (cause: unknown) {
      setError(cause instanceof ApiClientError ? cause.message : 'The change could not be completed. Check the latest values and try again.');
      return false;
    }
  }

  async function confirm(): Promise<void> {
    const pending = confirmAction;
    if (!pending || !csrfToken) return;
    setConfirmAction(null);
    if (pending.action === 'revoke') {
      await runAction(() => revokeAdminAccountSessions(csrfToken, pending.account.id), 'All active sessions were revoked.');
    } else {
      await runAction(() => setAdminAccountEnabled(csrfToken, pending.account.id, pending.action === 'enable'),
        pending.action === 'enable' ? 'Account enabled.' : 'Account disabled and its sessions revoked.');
    }
  }

  return <section className="grid w-full content-start gap-6" data-testid="admin-portal-page">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-2 [&>h1]:m-0 [&>p]:m-0"><p className="product-label">Administration</p><h1 className="text-3xl font-semibold">Admin portal</h1><p className="field-help">Manage your account and temporary demo visitors. No visitor signup is required.</p></div>
      <div className="flex flex-wrap gap-3"><Link className="self-center text-[var(--color-link)] underline underline-offset-4" to="/dashboard">Back to workspace</Link><Link className="self-center text-[var(--color-link)] underline underline-offset-4" to="/admin/showcase">Demo content</Link></div>
    </header>
    {error ? <Alert tone="error" role="alert" data-testid="admin-action-error">{error}</Alert> : null}
    {notice ? <Alert tone="success" role="status" data-testid="admin-action-success">{notice}</Alert> : null}

    <section className="grid gap-4" aria-labelledby="admin-accounts-heading">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 id="admin-accounts-heading" className="text-xl font-semibold">Accounts</h2><p className="field-help">Your owner account and temporary demo visitors.</p></div>
        </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search); }}>
        <div className="grid min-w-60 flex-1 gap-1"><Label htmlFor="admin-account-search">Search accounts</Label><Input id="admin-account-search" value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} /></div>
        <Button type="submit" variant="secondary">Search</Button>
        {appliedSearch ? <Button type="button" variant="ghost" onClick={() => { setSearch(''); setAppliedSearch(''); }}>Clear search</Button> : null}
      </form>
      {loadState.accounts === 'loading' ? <div aria-busy="true"><Skeleton className="h-20" /><Skeleton className="mt-3 h-20" /></div> : null}
      {loadState.accounts === 'error' ? <Alert tone="error">Accounts could not be loaded. <Button type="button" variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>Try again</Button></Alert> : null}
      {loadState.accounts === 'success' && accounts.length === 0 ? <Card className="p-5">{appliedSearch ? 'No accounts match this search.' : 'No accounts yet.'}</Card> : null}
      {loadState.accounts === 'success' ? <div className="grid gap-3">
        {accounts.map((account) => <AccountCard key={account.id} account={account} csrfToken={csrfToken} onAction={runAction}
          onConfirm={(action) => setConfirmAction({ account, action })} />)}
      </div> : null}
    </section>

    <section className="grid gap-4" aria-labelledby="admin-demo-settings-heading">
      <div><h2 id="admin-demo-settings-heading" className="text-xl font-semibold">Demo settings</h2><p className="field-help">Changes apply to new demo sessions except for shared budgets, pause, and concurrency.</p></div>
      {loadState.settings === 'loading' ? <Skeleton className="h-48" aria-busy="true" /> : null}
      {loadState.settings === 'error' ? <Alert tone="error">Demo settings could not be loaded. <Button type="button" variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>Try again</Button></Alert> : null}
      {settings ? <DemoSettingsForm key={settings.revision} settings={settings} csrfToken={csrfToken} onSave={runAction} /> : null}
    </section>

    <section className="grid gap-3" aria-labelledby="admin-audit-heading">
      <div><h2 id="admin-audit-heading" className="text-xl font-semibold">Recent admin changes</h2><p className="field-help">Account and settings changes.</p></div>
      {loadState.audit === 'loading' ? <Skeleton className="h-16" aria-busy="true" /> : null}
      {loadState.audit === 'error' ? <Alert tone="error">Recent changes could not be loaded. <Button type="button" variant="secondary" onClick={() => setRefreshKey((key) => key + 1)}>Try again</Button></Alert> : null}
      {loadState.audit === 'success' && audit.length === 0 ? <Card className="p-5">No admin changes yet.</Card> : null}
      {loadState.audit === 'success' && audit.length > 0 ? <ol className="grid gap-2">{audit.map((event) => <li key={event.id}><Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><strong>{auditActionLabel(event.action)}</strong><p className="field-help">{event.actorName ?? 'Former administrator'}{event.target_account_id ? ` · account ${event.target_account_id}` : ''}</p></div>
        <time className="field-help" dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
      </Card></li>)}</ol> : null}
    </section>

    <AlertDialogRoot open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
      <AlertDialogContent data-testid="admin-account-confirm">
        <AlertDialogTitle>{confirmAction?.action === 'revoke' ? 'Revoke all sessions?' : confirmAction?.action === 'disable' ? 'Disable this account?' : 'Enable this account?'}</AlertDialogTitle>
        <AlertDialogDescription>{confirmAction?.action === 'disable'
          ? 'The account will lose access and its active sessions will be revoked. In-flight provider work may finish.'
          : confirmAction?.action === 'revoke' ? 'The account will need to sign in again on every device.' : 'The account can sign in again using its current credentials.'}</AlertDialogDescription>
        <div className="dialog-actions"><AlertDialogCancel asChild><Button type="button" variant="secondary">Cancel</Button></AlertDialogCancel><Button type="button" variant={confirmAction?.action === 'disable' ? 'destructive' : 'primary'} onClick={() => { void confirm(); }}>Confirm</Button></div>
      </AlertDialogContent>
    </AlertDialogRoot>
  </section>;
}

function AccountCard({ account, csrfToken, onAction, onConfirm }: {
  readonly account: AdminAccountSummary; readonly csrfToken: string | null;
  readonly onAction: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  readonly onConfirm: (action: 'disable' | 'enable' | 'revoke') => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [daily, setDaily] = useState(account.daily.limitUnits ?? '');
  const [lifetime, setLifetime] = useState(account.lifetime.limitUnits ?? '');
  const [storage, setStorage] = useState(account.storage.limitBytes ?? '');
  const [resetOpen, setResetOpen] = useState(false);
  const [password, setPassword] = useState('');
  const canWrite = Boolean(csrfToken);
  const saveLimits = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!csrfToken) return;
    const saved = await onAction(() => updateAdminAccountLimits(csrfToken, account.id, {
      expectedRevision: account.limitsRevision, dailyCreditLimitUnits: nullable(daily),
      lifetimeCreditLimitUnits: nullable(lifetime), storageLimitBytes: nullable(storage)
    }), 'Account limits saved. Existing usage and data are unchanged.');
    if (saved) setEditing(false);
  };
  const reset = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!csrfToken) return;
    const saved = await onAction(() => resetAdminAccountPassword(csrfToken, account.id, password), 'Credentials reset and sessions revoked.');
    if (saved) { setPassword(''); setResetOpen(false); }
  };

  return <Card className="grid gap-4 p-4" data-testid={`admin-account-${account.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{account.displayName}</h3><p className="field-help">{account.identifier ?? 'No sign-in identifier'} · {account.accountKind} · {account.role} · {account.enabled ? 'Enabled' : 'Disabled'}</p>{account.expiresAt ? <p className="field-help">Expires {formatDate(account.expiresAt)}</p> : null}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={!canWrite} onClick={() => { setEditing((value) => !value); setDaily(account.daily.limitUnits ?? ''); setLifetime(account.lifetime.limitUnits ?? ''); setStorage(account.storage.limitBytes ?? ''); }}>{editing ? 'Close limits' : 'Edit limits'}</Button>
        <Button type="button" variant="secondary" disabled={!canWrite} onClick={() => setResetOpen(true)}>Reset credentials</Button>
        <Button type="button" variant="ghost" disabled={!canWrite} onClick={() => onConfirm('revoke')}>Revoke sessions</Button>
        <Button type="button" variant={account.enabled ? 'destructive' : 'secondary'} disabled={!canWrite || account.enabled && !account.canDisable} title={account.disableReason ?? undefined} onClick={() => onConfirm(account.enabled ? 'disable' : 'enable')}>{account.enabled ? 'Disable' : 'Enable'}</Button>
      </div>
    </div>
    {account.disableReason && account.enabled ? <p className="field-help">{account.disableReason}</p> : null}
    <div className="grid gap-2 sm:grid-cols-3">
      <UsageSummary title="Daily" summary={account.daily} />
      <UsageSummary title="Lifetime" summary={account.lifetime} />
      <div><strong>Storage</strong><p className="field-help">{account.storage.state === 'ready' && account.storage.usedBytes !== null ? `${formatBytes(account.storage.usedBytes)} (${account.storage.usedBytes} bytes)` : `Usage ${account.storage.state}`}</p><p className="field-help">Limit: {account.storage.limitBytes === null ? 'Unlimited' : `${account.storage.limitBytes} bytes`}</p></div>
    </div>
    {editing ? <form className="grid gap-3 border-t border-[var(--color-border)] pt-3 sm:grid-cols-3" onSubmit={(event) => { void saveLimits(event); }}>
      <LimitField id={`daily-${account.id}`} label="Daily credit limit" value={daily} setValue={setDaily} />
      <LimitField id={`lifetime-${account.id}`} label="Lifetime credit limit" value={lifetime} setValue={setLifetime} />
      <LimitField id={`storage-${account.id}`} label="Storage limit in bytes" value={storage} setValue={setStorage} />
      <p className="field-help sm:col-span-3">Leave blank for unlimited; enter 0 to block AI spending or storage growth. Lowering a limit keeps existing use and data and blocks further use when the limit is reached.</p>
      <div className="sm:col-span-3"><Button type="submit" disabled={!canWrite}>Save limits</Button></div>
    </form> : null}
    <DialogRoot open={resetOpen} onOpenChange={(open) => { if (!open) { setResetOpen(false); setPassword(''); } else setResetOpen(true); }}>
      <DialogContent data-testid={`password-reset-${account.id}`}>
        <DialogTitle>Reset credentials</DialogTitle><DialogDescription>Set a new password. Existing sessions will be revoked. The current password is never available.</DialogDescription>
        <form className="grid gap-3" onSubmit={(event) => { void reset(event); }}>
          <div className="grid gap-1"><Label htmlFor={`reset-password-${account.id}`}>New password</Label><Input autoComplete="new-password" id={`reset-password-${account.id}`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={1024} /></div>
          <div className="dialog-actions"><Button type="button" variant="secondary" onClick={() => { setResetOpen(false); setPassword(''); }}>Cancel</Button><Button type="submit" disabled={!password || !canWrite}>Reset credentials</Button></div>
        </form>
      </DialogContent>
    </DialogRoot>
  </Card>;
}

function UsageSummary({ title, summary }: { readonly title: string; readonly summary: AdminAccountSummary['daily'] }): React.JSX.Element {
  return <div><strong>{title}</strong><p className="field-help">Used {summary.settledUnits} · pending {summary.reservedUnits}</p><p className="field-help">Remaining {summary.remainingUnits ?? 'unlimited'} / limit {summary.limitUnits ?? 'unlimited'}</p></div>;
}

function LimitField({ id, label, value, setValue }: { readonly id: string; readonly label: string; readonly value: string; readonly setValue: (value: string) => void }): React.JSX.Element {
  return <div className="grid gap-1"><Label htmlFor={id}>{label}</Label><Input id={id} inputMode="numeric" pattern="0|[1-9][0-9]*" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Unlimited" /></div>;
}

function DemoSettingsForm({ settings, csrfToken, onSave }: {
  readonly settings: AdminDemoSettings; readonly csrfToken: string | null;
  readonly onSave: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => toSettingsDraft(settings));
  const update = (key: keyof DemoSettingsDraft, value: string | boolean): void => setDraft((current) => ({ ...current, [key]: value }));
  const field = (key: keyof DemoSettingsDraft, label: string, kind: 'units' | 'integer' | 'text' = 'integer'): React.JSX.Element => <div className="grid gap-1" key={key}>
    <Label htmlFor={`demo-${key}`}>{label}</Label><Input id={`demo-${key}`} inputMode={kind === 'text' ? undefined : 'numeric'} pattern={kind === 'text' ? undefined : '0|[1-9][0-9]*'} value={String(draft[key])} onChange={(event) => update(key, event.target.value)} placeholder="Unconfigured" />
  </div>;
  const campaignField = settings.campaignId === null ? field('campaignId', 'Campaign ID', 'text') : <div className="grid gap-1" key="campaignId">
    <Label htmlFor="demo-campaignId">Campaign ID</Label>
    <Input id="demo-campaignId" value={settings.campaignId} readOnly aria-describedby="demo-campaignId-help" />
    <p id="demo-campaignId-help" className="field-help">Campaign identity is set once. Budget edits keep using this campaign ledger.</p>
  </div>;
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!csrfToken) return;
    await onSave(() => saveAdminDemoSettings(csrfToken, {
      expectedRevision: settings.revision,
      defaultDailyLimitUnits: nullable(draft.defaultDailyLimitUnits), defaultLifetimeLimitUnits: nullable(draft.defaultLifetimeLimitUnits),
      sessionTtlHours: integerOrNull(draft.sessionTtlHours), globalAdmissionMax: integerOrNull(draft.globalAdmissionMax),
      globalAdmissionWindowSeconds: integerOrNull(draft.globalAdmissionWindowSeconds), networkAdmissionMax: integerOrNull(draft.networkAdmissionMax),
      networkAdmissionWindowSeconds: integerOrNull(draft.networkAdmissionWindowSeconds), runStartMax: integerOrNull(draft.runStartMax),
      runStartWindowSeconds: integerOrNull(draft.runStartWindowSeconds), maxConcurrentCalls: Number(draft.maxConcurrentCalls),
      globalDailyLimitUnits: nullable(draft.globalDailyLimitUnits), campaignId: nullable(draft.campaignId),
      campaignLimitUnits: nullable(draft.campaignLimitUnits), inferencePaused: draft.inferencePaused
    }), 'Demo settings saved. Existing counters and demo expiries were not reset.');
  }
  return <Card className="grid gap-4 p-5" data-testid="admin-demo-settings">
    <p className="field-help">{settings.demoSettingsBootstrapped ? 'Settings are persisted in the database.' : 'Environment defaults have not been seeded; blank values remain unconfigured.'}</p>
    <div><Button type="button" variant="secondary" onClick={() => setDraft((current) => ({ ...current,
      sessionTtlHours: current.sessionTtlHours || '24', globalAdmissionMax: current.globalAdmissionMax || '40',
      globalAdmissionWindowSeconds: current.globalAdmissionWindowSeconds || '3600', networkAdmissionMax: current.networkAdmissionMax || '5',
      networkAdmissionWindowSeconds: current.networkAdmissionWindowSeconds || '3600', runStartMax: current.runStartMax || '10',
      runStartWindowSeconds: current.runStartWindowSeconds || '3600'
    }))}>Fill missing demo limits</Button><p className="field-help">Fills empty expiry and visitor limits. Review and save below. AI budgets and the emergency pause stay as configured.</p></div>
    <div className="grid gap-1"><strong>Current shared usage</strong><p className="field-help">Daily: {settings.usage.dailySettledUnits} settled + {settings.usage.dailyReservedUnits} reserved ({settings.usage.dailyTimeZone}). Campaign: {settings.usage.campaignSettledUnits} settled + {settings.usage.campaignReservedUnits} reserved.</p></div>
    <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => { void submit(event); }}>
      {field('defaultDailyLimitUnits', 'New demo daily allowance', 'units')}
      {field('defaultLifetimeLimitUnits', 'New demo lifetime allowance', 'units')}
      {field('sessionTtlHours', 'Session expiry (hours)')}
      <details className="sm:col-span-2 lg:col-span-3" data-testid="demo-advanced-settings">
        <summary className="cursor-pointer py-3">Advanced limits and shared budget</summary>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {field('globalAdmissionMax', 'Global admissions per window')}
      {field('globalAdmissionWindowSeconds', 'Global admission window (seconds)')}
      {field('networkAdmissionMax', 'Admissions per network')}
      {field('networkAdmissionWindowSeconds', 'Network admission window (seconds)')}
      {field('runStartMax', 'Run starts per demo')}
      {field('runStartWindowSeconds', 'Run-start window (seconds)')}
      {field('maxConcurrentCalls', 'Concurrent AI calls')}
      {field('globalDailyLimitUnits', 'Shared demo daily budget', 'units')}
      {campaignField}
      {field('campaignLimitUnits', 'Campaign budget', 'units')}
        </div>
      </details>
      <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-3"><input type="checkbox" checked={draft.inferencePaused} onChange={(event) => update('inferencePaused', event.target.checked)} />Emergency pause for all AI inference (all accounts)</label>
      <p className="field-help sm:col-span-2 lg:col-span-3">This emergency pause blocks AI inference for regular and demo accounts. Blank means unconfigured for optional settings. Per-demo allowance defaults affect new demo identities; demo budgets take effect on future AI admission. Changing a window preserves existing active counters.</p>
      <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" disabled={!csrfToken}>Save demo settings</Button></div>
    </form>
  </Card>;
}

interface DemoSettingsDraft {
  defaultDailyLimitUnits: string; defaultLifetimeLimitUnits: string; sessionTtlHours: string; globalAdmissionMax: string;
  globalAdmissionWindowSeconds: string; networkAdmissionMax: string; networkAdmissionWindowSeconds: string; runStartMax: string;
  runStartWindowSeconds: string; maxConcurrentCalls: string; globalDailyLimitUnits: string; campaignId: string;
  campaignLimitUnits: string; inferencePaused: boolean;
}

function toSettingsDraft(settings: AdminDemoSettings): DemoSettingsDraft {
  return {
    defaultDailyLimitUnits: settings.defaultDailyLimitUnits ?? '', defaultLifetimeLimitUnits: settings.defaultLifetimeLimitUnits ?? '',
    sessionTtlHours: settings.sessionTtlHours?.toString() ?? '', globalAdmissionMax: settings.globalAdmissionMax?.toString() ?? '',
    globalAdmissionWindowSeconds: settings.globalAdmissionWindowSeconds?.toString() ?? '', networkAdmissionMax: settings.networkAdmissionMax?.toString() ?? '',
    networkAdmissionWindowSeconds: settings.networkAdmissionWindowSeconds?.toString() ?? '', runStartMax: settings.runStartMax?.toString() ?? '',
    runStartWindowSeconds: settings.runStartWindowSeconds?.toString() ?? '', maxConcurrentCalls: settings.maxConcurrentCalls.toString(),
    globalDailyLimitUnits: settings.globalDailyLimitUnits ?? '', campaignId: settings.campaignId ?? '',
    campaignLimitUnits: settings.campaignLimitUnits ?? '', inferencePaused: settings.inferencePaused
  };
}

function nullable(value: string): string | null { return value.trim() === '' ? null : value.trim(); }
function integerOrNull(value: string): number | null { return value.trim() === '' ? null : Number(value); }
function formatBytes(value: string): string {
  const bytes = BigInt(value); let divisor = 1n; const units = ['B', 'kB', 'MB', 'GB', 'TB']; let unit = 0;
  while (unit < units.length - 1 && bytes >= divisor * 1000n) { divisor *= 1000n; unit += 1; }
  return `${(bytes / divisor).toLocaleString()} ${units[unit]}`;
}
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function auditActionLabel(action: string): string {
  const labels: Record<string, string> = { 'account.created': 'Account created', 'account.disabled': 'Account disabled', 'account.enabled': 'Account enabled',
    'account.limits_updated': 'Account limits updated', 'account.password_reset': 'Credentials reset', 'account.sessions_revoked': 'Sessions revoked', 'demo.settings_updated': 'Demo settings updated' };
  return labels[action] ?? 'Admin change';
}
