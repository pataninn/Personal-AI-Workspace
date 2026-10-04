import { Alert, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button, Spinner } from '@/shared/ui';
import { DEFAULT_MODEL, REQUEST_ONLY_NOTICE, type EgressManifest } from '@/entities/ai-run';
import { ProviderTerms } from '@/features/ai-run/ui/ProviderTerms';

interface ProviderConsentDialogProps {
  readonly manifest: EgressManifest | null;
  readonly open: boolean;
  readonly decisionLoading: boolean;
  readonly decisionAction: 'approve' | 'reject' | null;
  readonly decisionError: string | null;
  readonly decisionOutcomeUnknown: boolean;
  readonly approveEnabled: boolean;
  readonly rememberProviderPermission: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApprove: () => void;
  readonly onRememberProviderPermissionChange: (checked: boolean) => void;
  readonly onReject: () => void;
  readonly onRefreshDisclosure: () => void;
  readonly onRefreshStatus: () => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}

export function ProviderConsentDialog({
  manifest,
  open,
  decisionLoading,
  decisionAction,
  decisionError,
  decisionOutcomeUnknown,
  approveEnabled,
  rememberProviderPermission,
  onOpenChange,
  onApprove,
  onRememberProviderPermissionChange,
  onReject,
  onRefreshDisclosure,
  onRefreshStatus,
  onCloseAutoFocus
}: ProviderConsentDialogProps): React.JSX.Element | null {
  if (!manifest) {
    return null;
  }
  const hasContext = manifest.relativePaths.length > 0
    || manifest.categories.some((category) => category !== 'Request')
    || manifest.itemCount > manifest.relativePaths.length
    || manifest.messageCount > 0
    || manifest.facts.length > 0;
  const isStale = decisionError === 'This disclosure is no longer current. Review the updated scope before approving.';
  const actionsDisabled = decisionLoading || decisionOutcomeUnknown;
  const statusText = decisionLoading
    ? decisionAction === 'approve' ? 'Approving…' : decisionAction === 'reject' ? 'Keeping this run local…' : 'Refreshing provider disclosure…'
    : decisionOutcomeUnknown ? 'Decision status could not be confirmed. Refresh the run status before deciding again.' : '';

  return (
    <AlertDialogRoot open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        data-testid="provider-consent-alert-dialog"
        aria-busy={decisionLoading || undefined}
        onEscapeKeyDown={(event) => {
          if (actionsDisabled) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          onReject();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogTitle data-testid="provider-consent-title">Send selected context to {manifest.provider}?</AlertDialogTitle>
        <AlertDialogDescription data-testid="provider-consent-description">
          To answer this request, the approved context below will be sent server-side to {manifest.provider}. Review the exact scope before deciding.
        </AlertDialogDescription>

        <Alert tone="warning" data-testid="provider-consent-no-staging-notice">
          {manifest.preConsentNotice}
        </Alert>

        <Alert tone="warning" data-testid="provider-consent-sensitive-classification">
          <strong>Sensitive action:</strong> approving sends the request and selected context to {manifest.provider}. Choosing files, messages, or facts is a safe local step; it does not send them by itself.
        </Alert>

        <div className="provider-consent-terms" data-testid="provider-consent-provider-terms">
          <ProviderTerms providerProfile={manifest.providerProfile} />
        </div>

        <div className="provider-consent-manifest" data-testid="provider-consent-manifest">
          <dl className="provider-consent-details">
            <div>
              <dt>Provider</dt>
              <dd data-testid="provider-consent-provider">{manifest.provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd data-testid="provider-consent-model">{formatModelLabel(manifest.model)}</dd>
            </div>
            <div>
              <dt>Estimated content</dt>
              <dd data-testid="provider-consent-size-estimate">{formatBytes(manifest.byteEstimate)}</dd>
            </div>
            <div>
              <dt>Estimated tokens</dt>
              <dd data-testid="provider-consent-token-estimate">{manifest.tokenEstimate.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Selected files</dt>
              <dd data-testid="provider-consent-file-count">{manifest.relativePaths.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Recent messages</dt>
              <dd data-testid="provider-consent-message-count">{manifest.messageCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Selected facts</dt>
              <dd data-testid="provider-consent-fact-count">{manifest.facts.length.toLocaleString()}</dd>
            </div>
          </dl>

          <section className="provider-consent-context" aria-labelledby="provider-consent-context-heading">
            <h3 id="provider-consent-context-heading">Approved context</h3>
            <ul data-testid="provider-consent-context" aria-label="Approved context categories and relative paths">
              <li>Request included</li>
              <li data-testid="provider-consent-categories">Content categories: {manifest.categories.join(', ')}</li>
              {manifest.messageCount > 0 ? <li>Recent conversation: {manifest.messageCount.toLocaleString()} {manifest.messageCount === 1 ? 'message' : 'messages'}</li> : null}
              {manifest.facts.length > 0 ? <li>Project memory: {manifest.facts.length.toLocaleString()} {manifest.facts.length === 1 ? 'fact' : 'facts'}</li> : null}
              {manifest.relativePaths.length > 0 ? <li>Project files: {manifest.relativePaths.length.toLocaleString()}</li> : null}
              {manifest.relativePaths.map((path) => <li key={path}><code>{path}</code></li>)}
              {!hasContext ? <li>{REQUEST_ONLY_NOTICE}</li> : null}
            </ul>
          </section>

          {manifest.facts.length > 0 ? <section className="provider-consent-facts" aria-labelledby="provider-consent-facts-heading">
            <h3 id="provider-consent-facts-heading">Selected project facts</h3>
            <ol data-testid="provider-consent-facts">
              {manifest.facts.map((fact) => <li key={fact.id}>
                <h4>{fact.title}</h4>
                <p><strong>Source:</strong> {fact.source.label}</p>
                <p><strong>Review status:</strong> {fact.verificationStatus === 'verified' ? 'Verified by you' : 'Needs review'}</p>
                <p className="memory-fact-value" data-testid="provider-consent-fact-content">{fact.content}</p>
              </li>)}
            </ol>
          </section> : null}

          <p className="provider-consent-redaction" data-testid="provider-consent-redaction-summary">
            <strong>Excluded by local safety policy:</strong> {manifest.excludedItemCount + manifest.omittedItemCount} item{manifest.excludedItemCount + manifest.omittedItemCount === 1 ? '' : 's'}. {manifest.omissionSummary}
          </p>
          <p className="field-help">Automatic secret detection is best effort. Review the listed relative paths before approving.</p>
        </div>

        <section className="provider-permission-grant" aria-labelledby="provider-permission-grant-heading">
          <h3 id="provider-permission-grant-heading">Remember this provider permission?</h3>
          <label className="provider-permission-check">
            <input
              type="checkbox"
              data-testid="provider-consent-remember-permission"
              checked={rememberProviderPermission}
              onChange={(event) => onRememberProviderPermissionChange(event.currentTarget.checked)}
              disabled={actionsDisabled}
            />
            <span>Allow future Ask AI requests in this project to send their request and the context I select to {manifest.provider} using {formatModelLabel(manifest.model)}, until I revoke it.</span>
          </label>
          {rememberProviderPermission ? <dl className="provider-permission-scope" data-testid="provider-consent-permission-scope">
            <div><dt>Granted to</dt><dd>You, in this signed-in account</dd></div>
            <div><dt>Project</dt><dd>This project only</dd></div>
            <div><dt>Provider</dt><dd>{manifest.provider} · {formatModelLabel(manifest.model)}</dd></div>
            <div><dt>Capability</dt><dd>Send the request and explicitly selected project context</dd></div>
            <div><dt>Lasts</dt><dd>Until revoked in Provider permissions above the prompt</dd></div>
            <div><dt>Other approvals</dt><dd>File changes and commands still require their own approval</dd></div>
          </dl> : null}
        </section>

        {decisionError ? <Alert tone={isStale ? 'warning' : 'error'} data-testid="provider-consent-error" role="alert">{decisionError}</Alert> : null}
        {statusText ? <div className="form-status" data-testid="provider-consent-status" role="status" aria-live="polite" aria-busy="true"><Spinner label={statusText} /><span>{statusText}</span></div> : null}

        <div className="dialog-actions provider-consent-actions">
          {decisionOutcomeUnknown ? <Button type="button" variant="secondary" data-testid="provider-consent-refresh" onClick={onRefreshStatus}>Refresh run status</Button> : null}
          {isStale ? <Button type="button" variant="secondary" data-testid="provider-consent-refresh" disabled={decisionLoading} onClick={onRefreshDisclosure}>Refresh disclosure</Button> : null}
          <Button type="button" variant="secondary" data-testid="provider-consent-reject" disabled={actionsDisabled} aria-busy={decisionLoading && decisionAction === 'reject'} onClick={onReject}>{decisionLoading && decisionAction === 'reject' ? 'Keeping this run local…' : 'Reject and keep local'}</Button>
          <Button type="button" data-testid="provider-consent-approve" disabled={actionsDisabled || isStale || !approveEnabled} aria-busy={decisionLoading && decisionAction === 'approve'} onClick={onApprove}>{decisionLoading && decisionAction === 'approve' ? 'Approving…' : 'Approve and continue'}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes.toLocaleString()} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB (${bytes.toLocaleString()} bytes)`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB (${bytes.toLocaleString()} bytes)`;
}

function formatModelLabel(model: string): string {
  return model === DEFAULT_MODEL ? `Nemotron 3 Super 120B (${model})` : model;
}
