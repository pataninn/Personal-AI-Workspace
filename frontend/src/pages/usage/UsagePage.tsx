import { Link } from 'react-router-dom';

import { useAccountUsage } from '@/entities/account-usage';
import { WorkspaceExportPanel } from '@/features/workspace-export';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';

export function UsagePage(): React.JSX.Element {
  const { state, refresh } = useAccountUsage();
  return <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8" data-testid="usage-page">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="product-label">Account</p><h1 className="text-3xl font-semibold">Usage</h1><p className="field-help">Your current account allowances and logical workspace storage.</p></div>
      <Link className="text-[var(--color-link)] underline underline-offset-4" to="/dashboard">Back to workspace</Link>
    </header>
    {state.status === 'loading' ? <div className="grid gap-4 md:grid-cols-3" aria-busy="true" data-testid="usage-loading">
      <Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" />
    </div> : null}
    {state.status === 'error' ? <Alert tone="error" data-testid="usage-error"><p>Usage unavailable. Your AI controls stay disabled until the current allowance can be checked.</p><Button type="button" variant="secondary" onClick={refresh}>Try again</Button></Alert> : null}
    {state.status === 'success' ? <>
      <section className="grid gap-4 md:grid-cols-3" aria-label="Account usage totals">
        <CreditCard title="Daily credits" usage={state.data.daily} />
        <CreditCard title="Lifetime credits" usage={state.data.lifetime} />
        <StorageCard usage={state.data.storage} />
      </section>
      <section aria-label="AI availability">
        {state.data.availability.status === 'available'
          ? <Alert tone="success" data-testid="usage-availability">AI budget availability is confirmed for this account. Provider readiness may vary.</Alert>
          : <Alert tone={state.data.availability.status === 'unknown' ? 'warning' : 'info'} data-testid="usage-availability">
            <p>{state.data.availability.reason ?? 'AI submissions are currently unavailable.'}</p>
            {state.data.availability.status === 'unknown' ? <Button type="button" variant="secondary" onClick={refresh}>Check again</Button> : null}
          </Alert>}
      </section>
      <p className="field-help">Updated {formatDate(state.data.asOf)}. Credits measure the configured AI budget. Storage is logical persistent data, not physical disk use.</p>
    </> : null}
    <WorkspaceExportPanel />
  </main>;
}

function CreditCard({ title, usage }: { readonly title: string; readonly usage: { readonly limitUnits: string | null; readonly settledUnits: string; readonly reservedUnits: string; readonly remainingUnits: string | null; readonly resetAt?: string; readonly timeZone?: string } }): React.JSX.Element {
  const total = BigInt(usage.settledUnits) + BigInt(usage.reservedUnits);
  return <Card className="grid content-start gap-3 p-5" data-testid={`usage-${title.toLowerCase().replaceAll(' ', '-')}`}>
    <h2 className="text-lg font-semibold">{title}</h2>
    {total === 0n ? <p className="field-help">No AI usage yet.</p> : null}
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
      <dt>Allowance</dt><dd>{usage.limitUnits === null ? 'Unlimited' : formatCount(usage.limitUnits)}</dd>
      <dt>Consumed</dt><dd>{formatCount(usage.settledUnits)}</dd>
      <dt>Pending reservations</dt><dd>{formatCount(usage.reservedUnits)}</dd>
      <dt>Remaining</dt><dd>{usage.remainingUnits === null ? 'Unlimited' : formatCount(usage.remainingUnits)}</dd>
    </dl>
    {usage.resetAt ? <p className="field-help">Resets {formatInZone(usage.resetAt, usage.timeZone ?? 'UTC')} ({usage.timeZone ?? 'UTC'}).</p> : null}
  </Card>;
}

function StorageCard({ usage }: { readonly usage: { readonly state: string; readonly usedBytes: string | null; readonly reservedBytes: string | null; readonly limitBytes: string | null; readonly asOf: string | null } }): React.JSX.Element {
  const ready = usage.state === 'ready' && usage.usedBytes !== null && usage.reservedBytes !== null;
  return <Card className="grid content-start gap-3 p-5" data-testid="usage-workspace-storage">
    <h2 className="text-lg font-semibold">Workspace data storage</h2>
    {ready ? <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
      <dt>Used</dt><dd>{formatBytes(usage.usedBytes!)} ({usage.usedBytes} bytes)</dd>
      <dt>Reserved</dt><dd>{formatBytes(usage.reservedBytes!)} ({usage.reservedBytes} bytes)</dd>
      <dt>Limit</dt><dd>{usage.limitBytes === null ? 'Unlimited' : `${formatBytes(usage.limitBytes)} (${usage.limitBytes} bytes)`}</dd>
    </dl> : <p className="field-help">Storage usage unavailable while accounting is {usage.state}.</p>}
    {usage.asOf ? <p className="field-help">Updated {formatDate(usage.asOf)}.</p> : null}
  </Card>;
}

function formatCount(value: string): string { return BigInt(value).toLocaleString(); }

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && bytes >= divisor * 1000n) { divisor *= 1000n; unit += 1; }
  const whole = bytes / divisor;
  if (unit === 0 || bytes % divisor === 0n) return `${whole.toLocaleString()} ${units[unit]}`;
  const tenths = (bytes * 10n / divisor) % 10n;
  return `${whole.toLocaleString()}.${tenths.toString()} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'unavailable';
}

function formatInZone(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unavailable';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date); }
  catch { return formatDate(value); }
}
