import { useCallback, useEffect, useState } from 'react';

import { listProviderPermissions, revokeProviderPermission, type ProviderPermission } from '@/entities/ai-run';
import { Alert, Button } from '@/shared/ui';

interface ProviderPermissionManagerProps {
  readonly projectId: string;
  readonly csrfToken: string | null;
  readonly onListStateChange: (ready: boolean) => void;
}

export function ProviderPermissionManager({ projectId, csrfToken, onListStateChange }: ProviderPermissionManagerProps): React.JSX.Element {
  const [permissions, setPermissions] = useState<readonly ProviderPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activePermissions = permissions.filter((permission) => permission.revokedAt === null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    onListStateChange(false);
    try {
      setPermissions(await listProviderPermissions(projectId));
      setError(null);
      onListStateChange(true);
    } catch {
      setError('Provider permissions could not be loaded. Try again before starting a request.');
      onListStateChange(false);
    } finally {
      setLoading(false);
    }
  }, [onListStateChange, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleRefresh = (): void => { void refresh(); };
    window.addEventListener('personal-ai:provider-permissions-changed', handleRefresh);
    return () => window.removeEventListener('personal-ai:provider-permissions-changed', handleRefresh);
  }, [refresh]);

  async function revoke(permission: ProviderPermission): Promise<void> {
    if (!csrfToken || revokingId) return;
    setRevokingId(permission.id);
    setError(null);
    try {
      await revokeProviderPermission(projectId, permission.id, csrfToken);
      await refresh();
      window.dispatchEvent(new CustomEvent('personal-ai:provider-permissions-changed'));
      window.dispatchEvent(new CustomEvent('personal-ai:provider-permissions-revoked'));
    } catch {
      setError('This permission could not be revoked. Refresh and try again.');
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section id="provider-permission-manager" className="provider-permission-manager" data-testid="provider-permission-manager" aria-label="Provider permissions">
      {activePermissions.length > 0 ? <Alert tone="warning" data-testid="provider-permission-active-notice">
        <strong>Sensitive permission active.</strong> Sending a project chat request sends your request and the project context you select without another provider approval when the provider and model match an active permission below. File changes and commands still require separate approval.
      </Alert> : null}
      <details>
        <summary data-testid="provider-permission-manager-toggle">Provider permissions{activePermissions.length > 0 ? ` (${activePermissions.length} active)` : ''}</summary>
        {loading ? <p className="field-help" role="status">Loading provider permissions…</p> : null}
        {error ? <Alert tone="error" role="alert">{error}</Alert> : null}
        {!loading && permissions.length === 0 ? <p className="field-help">No remembered provider permissions for this project.</p> : null}
        <ul className="provider-permission-list" data-testid="provider-permission-list">
          {permissions.map((permission) => {
            const active = permission.revokedAt === null;
            return <li key={permission.id} data-testid="provider-permission-item">
              <dl>
                <div><dt>Granted to</dt><dd>Signed-in account</dd></div>
                <div><dt>Project</dt><dd>This project only</dd></div>
                <div><dt>Provider and model</dt><dd>{providerLabel(permission.providerProfile)} · {formatModel(permission.model)}</dd></div>
                <div><dt>Capability</dt><dd>Send each request and explicitly selected project context</dd></div>
                <div><dt>Persistence</dt><dd>{active ? 'Until revoked' : `Revoked ${formatDate(permission.revokedAt)}`}</dd></div>
              </dl>
              {active ? <Button
                type="button"
                variant="secondary"
                data-testid="provider-permission-revoke"
                disabled={!csrfToken || revokingId !== null}
                aria-busy={revokingId === permission.id}
                onClick={() => { void revoke(permission); }}
              >{revokingId === permission.id ? 'Revoking…' : 'Revoke permission'}</Button> : <p className="field-help">This permission no longer authorizes provider requests.</p>}
            </li>;
          })}
        </ul>
        <p className="field-help" data-testid="provider-permission-revocation-note">Revoking returns approved runs that have not started to the review step. A request already in progress or sent cannot be recalled.</p>
        <p className="field-help">Permissions apply only to the listed provider and model. Review that provider&apos;s terms in its approval dialog before granting permission.</p>
        <Button type="button" variant="secondary" disabled={loading} onClick={() => { void refresh(); }}>Refresh permissions</Button>
      </details>
    </section>
  );
}

function providerLabel(profile: string): string {
  if (profile === 'nebius-token-factory') return 'Nebius Token Factory';
  return profile === 'nvidia-hosted-nim' ? 'NVIDIA hosted NIM' : profile;
}

function formatModel(model: string): string {
  return model === 'nvidia/nemotron-3-super-120b-a12b' ? `Nemotron 3 Super 120B (${model})` : model;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'date unavailable';
}
