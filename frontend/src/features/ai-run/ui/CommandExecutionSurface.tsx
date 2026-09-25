import type { AiRunSnapshot } from '@/entities/ai-run';
import { Alert, Button, Card, Skeleton } from '@/shared/ui';

import { selectCsrfToken } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import {
  COMMAND_BOUNDARY_NOTICE,
  COMMAND_EMPTY_NOTICE,
  COMMAND_PROMOTION_NOTICE,
  COMMAND_STATUS_LOAD_ERROR
} from '@/features/ai-run/model/command-copy';
import { useSandboxCommands } from '@/features/ai-run/model/use-sandbox-commands';
import { CommandProposalCard } from '@/features/ai-run/ui/CommandProposalCard';

interface CommandExecutionSurfaceProps {
  readonly run: AiRunSnapshot;
  readonly conversationHref?: string;
  readonly readOnly?: boolean;
}

export function CommandExecutionSurface({ run, conversationHref, readOnly = false }: CommandExecutionSurfaceProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  // The command surface is retained as dormant compatibility code for the
  // earlier sandbox runtime. Direct provider runs never render it.
  const runtimeKind = run.runtime?.kind === 'fake' ? 'fake' : undefined;
  const commands = useSandboxCommands({ enabled: ['ready', 'queued', 'running', 'waiting_approval'].includes(run.status) && Boolean(run.runtime?.sandboxReady), runId: run.runId, csrfToken });
  const canMutate = Boolean(csrfToken) && !readOnly;
  return (
    <section className="command-execution-surface" data-testid="command-execution-surface" aria-labelledby="command-surface-heading">
      <h2 id="command-surface-heading" data-testid="command-surface-heading">Sandbox commands</h2>
      <p className="field-help">{COMMAND_BOUNDARY_NOTICE}</p>
      <p className="field-help">{COMMAND_PROMOTION_NOTICE}</p>
      {readOnly ? <Alert tone="warning" data-testid="command-project-read-only">This project is archived. Existing sandbox commands are read-only.</Alert> : null}
      {commands.status === 'loading' ? <LoadingState /> : null}
      {commands.status === 'error' ? <SurfaceError onRefresh={commands.refresh} /> : null}
      {commands.status === 'success' && commands.commands.length === 0 ? <div data-testid="command-empty" className="command-empty-state"><p>{COMMAND_EMPTY_NOTICE}</p></div> : null}
      {commands.status === 'success' && commands.commands.length > 0 ? <ol className="command-list">{commands.commands.map((command) => <li key={command.commandId}><CommandProposalCard command={command} runtimeKind={runtimeKind} actionState={commands.actions[command.commandId]} canMutate={canMutate} onDecision={(decision) => commands.decide(command, decision)} onCancel={() => commands.cancel(command)} onRefresh={commands.refresh} conversationHref={conversationHref} /></li>)}</ol> : null}
    </section>
  );
}

function LoadingState(): React.JSX.Element {
  return (
    <div data-testid="command-loading" aria-busy="true">
      <p data-testid="command-loading-status" role="status" aria-live="polite">Loading command status...</p>
      <Card className="command-loading-card"><Skeleton className="command-loading-line" /><Skeleton className="command-loading-line command-loading-line-short" /></Card>
    </div>
  );
}

function SurfaceError({ onRefresh }: { readonly onRefresh: () => void }): React.JSX.Element {
  return (
    <div data-testid="command-surface-error" role="alert">
      <Alert tone="error">{COMMAND_STATUS_LOAD_ERROR}</Alert>
      <Button type="button" variant="secondary" data-testid="command-surface-retry" onClick={onRefresh}>Refresh command status</Button>
    </div>
  );
}
