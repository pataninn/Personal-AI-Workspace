import { ProviderTerms, type AssistantContextCategory, type AssistantExecutionPolicyStatus, type AssistantToolCapability } from '@/entities/assistant-policy';
import { Card } from '@/shared/ui';

export interface AssistantPolicySummaryProps {
  readonly status: 'loading' | 'error' | 'loaded';
  readonly policy: AssistantExecutionPolicyStatus | null;
  readonly compact?: boolean;
}

const CATEGORY_LABELS: Readonly<Record<AssistantContextCategory, string>> = {
  current_message: 'Current message',
  bounded_home_history: 'Recent Home conversation',
  task_metadata: 'Task details',
  workspace_metadata: 'Workspace details',
  request: 'Current request',
  recent_conversation: 'Recent conversation',
  project_files: 'Selected workspace files',
  project_facts: 'Selected project facts'
};

const CAPABILITY_LABELS: Readonly<Record<AssistantToolCapability, string>> = {
  home_task_read: 'Read Home tasks',
  home_task_write: 'Update Home tasks',
  home_workspace_read: 'Read workspace summaries',
  home_workspace_write: 'Update workspace details',
  home_action_undo: 'Undo supported Home actions',
  workspace_file_read: 'Read selected workspace files',
  workspace_file_write: 'Update selected workspace files',
  bounded_sandbox_command: 'Run bounded workspace tools'
};

/** Usage: render full details with `<AssistantPolicySummary status="loaded" policy={policy} />`; pass `compact` in a tight composer, where the disclosure stays visible and only context/actions collapse. */
export function AssistantPolicySummary({ status, policy, compact = false }: AssistantPolicySummaryProps): React.JSX.Element {
  const loadedStatus = status === 'loaded' ? policy : null;
  const readinessLabel = status === 'loading' ? 'Checking assistant availability…'
    : status === 'error' ? 'Assistant availability could not be checked.'
      : readinessMessage(policy);

  return <section aria-label="Assistant policy summary" className="w-full">
    <Card className={compact ? 'space-y-1 p-2' : 'space-y-3 p-4'}>
      {compact ? <>
        <p className="m-0 break-words text-xs text-[var(--color-text-muted)]">{loadedStatus ? safeScopeLabel(loadedStatus.scope) : 'Current scope'}</p>
        <p className="m-0 text-xs text-[var(--color-text-muted)]" role="status" aria-live="polite" data-testid="assistant-policy-readiness">{readinessLabel}</p>
        {loadedStatus ? <>
          <p className="m-0 break-words text-xs text-[var(--color-text-muted)]">{providerLabel(loadedStatus.policy?.provider ?? null)}</p>
          <ProviderDisclosure status={loadedStatus} compact />
          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2">Context and permitted actions</summary>
            <div className="max-h-40 overflow-y-auto py-2"><SummaryContent status={loadedStatus} /></div>
          </details>
        </> : null}
      </> : <>
      <SummaryHeading scopeLabel={loadedStatus ? safeScopeLabel(loadedStatus.scope) : 'Current scope'} readinessLabel={readinessLabel} />
      {loadedStatus ? <>
        <ProviderDisclosure status={loadedStatus} />
        <SummaryContent status={loadedStatus} />
      </> : null}
      </>}
    </Card>
  </section>;
}

function SummaryHeading({ scopeLabel, readinessLabel }: { readonly scopeLabel: string; readonly readinessLabel: string }): React.JSX.Element {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Assistant scope</h2>
      <p className="break-words text-sm text-[var(--color-text-muted)]">{scopeLabel}</p>
    </div>
    <p className="text-sm text-[var(--color-text-muted)]" role="status" aria-live="polite" data-testid="assistant-policy-readiness">{readinessLabel}</p>
  </div>;
}

function SummaryContent({ status }: { readonly status: AssistantExecutionPolicyStatus }): React.JSX.Element {
  const policy = status.policy;
  const ready = isExecutionReady(status);
  return <>
    <dl className="m-0 grid gap-2 text-sm">
      <div><dt className="font-medium text-[var(--color-text)]">Provider</dt><dd className="m-0 break-words text-[var(--color-text-muted)]">{providerLabel(policy?.provider ?? null)}</dd></div>
      <div><dt className="font-medium text-[var(--color-text)]">Availability</dt><dd className="m-0 text-[var(--color-text-muted)]">{ready ? 'Ready' : 'Unavailable'}</dd></div>
    </dl>
    {policy === null ? <p className="text-sm text-[var(--color-text-muted)]">Policy details are unavailable.</p>
      : policy.enabled ? <PolicyDetails policy={policy} scopeKind={status.scope.kind} fileAccess={status.fileAccess} />
        : <p className="text-sm text-[var(--color-text-muted)]">Execution is turned off for this scope.</p>}
    {status.scope.kind === 'workspace' && !status.fileAccess ? <p className="text-sm text-[var(--color-text-muted)]">Files and file tools are unavailable in this workspace. Task and planning assistance remain available where enabled.</p> : null}
  </>;
}

function ProviderDisclosure({ status, compact = false }: {
  readonly status: AssistantExecutionPolicyStatus;
  readonly compact?: boolean;
}): React.JSX.Element {
  const policy = status.policy;
  const provider = policy?.provider ?? null;
  let transmission: string;
  if (policy === null) {
    transmission = 'Provider configuration is unavailable, so whether selected context is sent cannot be determined.';
  } else if (provider === null) {
    transmission = 'No provider is configured, so selected context is not sent to an AI provider.';
  } else if (!policy.enabled || status.readiness.state === 'blocked') {
    transmission = `Execution is blocked by policy, so no request is sent to the provider. If policy permits execution and you submit a request, selected context will be sent to ${provider.name} for processing.`;
  } else if (status.readiness.state === 'ready') {
    transmission = `When you submit an assistant request, selected context is sent to ${provider.name} for processing.`;
  } else if (status.readiness.reasonCode === 'runtime_unverified') {
    transmission = `The configured assistant runtime is unavailable, so no request is sent to the provider. If it becomes available and policy permits execution, selected context will be sent to ${provider.name} for processing.`;
  } else {
    transmission = `The assistant is currently unavailable, so no request is sent to the provider. If execution becomes available and policy permits it, selected context will be sent to ${provider.name} for processing.`;
  }

  return <div className={compact ? 'space-y-1 text-xs' : 'space-y-1 text-sm'}>
    <p className={compact ? 'm-0 break-words text-xs text-[var(--color-text-muted)]' : 'm-0 text-sm text-[var(--color-text-muted)]'}>
      Workspace data is stored on the operator-managed deployment. {transmission}
    </p>
    {provider ? <ProviderTerms providerName={provider.name} /> : null}
  </div>;
}

function PolicyDetails({ policy, scopeKind, fileAccess }: {
  readonly policy: NonNullable<AssistantExecutionPolicyStatus['policy']>;
  readonly scopeKind: AssistantExecutionPolicyStatus['scope']['kind'];
  readonly fileAccess: boolean;
}): React.JSX.Element {
  const categories = policy.included.categories.map((category) => CATEGORY_LABELS[category]);
  const files = policy.included.items.map((item) => safeRelativeFileName(item.name)).filter((name): name is string => name !== null);
  const capabilities = policy.capabilities.filter((capability) => fileAccess || scopeKind !== 'workspace' || !requiresWorkspaceFiles(capability));
  return <div className="space-y-2 text-sm">
    <ContextSummary categories={categories} files={files} />
    <CapabilitySummary capabilities={capabilities} exclusionsEnforced={policy.exclusionsEnforced} />
  </div>;
}

function ContextSummary({ categories, files }: { readonly categories: readonly string[]; readonly files: readonly string[] }): React.JSX.Element {
  const labels = [...categories, ...files];
  return <div>
    <h3 className="font-medium text-[var(--color-text)]">Included context</h3>
    {labels.length > 0
      ? <ul className="list-inside list-disc text-[var(--color-text-muted)]">{labels.map((label) => <li key={label}>{label}</li>)}</ul>
      : <p className="text-[var(--color-text-muted)]">No additional context is selected.</p>}
  </div>;
}

function CapabilitySummary({ capabilities, exclusionsEnforced }: {
  readonly capabilities: readonly AssistantToolCapability[];
  readonly exclusionsEnforced: true;
}): React.JSX.Element {
  return <div>
    <h3 className="font-medium text-[var(--color-text)]">Actions in this policy</h3>
    {capabilities.length > 0
      ? <ul className="list-inside list-disc text-[var(--color-text-muted)]">{capabilities.map((capability) => <li key={capability}>{CAPABILITY_LABELS[capability]}</li>)}</ul>
      : <p className="text-[var(--color-text-muted)]">No assistant actions are enabled for this scope.</p>}
    {exclusionsEnforced ? <p className="text-[var(--color-text-muted)]">Protected locations, other workspaces, and unselected items stay outside this scope.</p> : null}
  </div>;
}

function isExecutionReady(status: AssistantExecutionPolicyStatus): boolean {
  return status.readiness.state === 'ready' && status.policy?.enabled === true && status.policy.provider !== null;
}

function readinessMessage(status: AssistantExecutionPolicyStatus | null): string {
  if (!status?.policy) return 'Assistant policy is unavailable.';
  if (!status.policy.enabled || status.readiness.state === 'blocked') return 'Execution is blocked by policy.';
  if (status.readiness.state === 'ready' && status.policy.provider !== null) return 'Assistant is available.';
  if (status.readiness.state === 'unavailable' && status.readiness.reasonCode === 'provider_unconfigured') return 'The provider is not configured.';
  if (status.readiness.state === 'unavailable' && status.readiness.reasonCode === 'runtime_unverified') return 'The configured assistant runtime is unavailable.';
  return 'Assistant execution is unavailable.';
}

function providerLabel(provider: NonNullable<AssistantExecutionPolicyStatus['policy']>['provider']): string {
  return provider ? `${provider.name} · ${provider.model}` : 'Not configured';
}

function safeScopeLabel(scope: AssistantExecutionPolicyStatus['scope']): string {
  const label = scope.label.trim();
  if (!label || isHostPath(label)) return scope.kind === 'home' ? 'Home' : 'Workspace';
  return label;
}

function safeRelativeFileName(value: string): string | null {
  const name = value.trim().replaceAll('\\', '/');
  if (!name || name.startsWith('/') || /^[a-z]:/iu.test(name) || name.split('/').some((part) => part === '..') || /[\u0000-\u001f\u007f]/u.test(name)) return null;
  return name;
}

function isHostPath(value: string): boolean {
  return /^[a-z]:/iu.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function requiresWorkspaceFiles(capability: AssistantToolCapability): boolean {
  return capability === 'workspace_file_read' || capability === 'workspace_file_write' || capability === 'bounded_sandbox_command';
}
