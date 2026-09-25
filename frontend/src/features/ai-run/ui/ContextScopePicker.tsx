import { useEffect, useState } from 'react';

import { flattenWorkspaceFiles, getWorkspaceTree, type WorkspaceFileCandidate } from '@/entities/workspace';
import { Alert, Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, DialogTrigger, EmptyState, Spinner } from '@/shared/ui';

interface ContextScopePickerProps {
  readonly projectId: string;
  readonly selectedPaths: readonly string[];
  readonly includeRecentMessages: boolean;
  readonly recentMessageCount: number;
  readonly disabled?: boolean;
  readonly onChange: (selection: { readonly relativePaths: readonly string[]; readonly includeRecentMessages: boolean }) => void;
}

type LoadState = 'idle' | 'loading' | 'success' | 'error';

export function ContextScopePicker({ projectId, selectedPaths, includeRecentMessages, recentMessageCount, disabled = false, onChange }: ContextScopePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [files, setFiles] = useState<readonly WorkspaceFileCandidate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftPaths, setDraftPaths] = useState<readonly string[]>(selectedPaths);
  const [draftMessages, setDraftMessages] = useState(includeRecentMessages);

  useEffect(() => {
    setLoadState('idle');
    setFiles([]);
    setLoadError(null);
  }, [projectId]);

  useEffect(() => {
    if (open) {
      setDraftPaths(selectedPaths);
      setDraftMessages(includeRecentMessages);
    }
  }, [includeRecentMessages, open, selectedPaths]);

  function openPicker(): void {
    setOpen(true);
    if (loadState === 'idle' || loadState === 'error') {
      void loadFiles();
    }
  }

  async function loadFiles(): Promise<void> {
    setLoadState('loading');
    setLoadError(null);
    try {
      const tree = await getWorkspaceTree(projectId);
      setFiles(flattenWorkspaceFiles(tree));
      setLoadState('success');
    } catch {
      setLoadState('error');
      setLoadError('Project files could not be loaded safely. Try again before selecting context.');
    }
  }

  function togglePath(path: string): void {
    setDraftPaths((current) => current.includes(path) ? current.filter((candidate) => candidate !== path) : [...current, path].sort());
  }

  function applySelection(): void {
    onChange({ relativePaths: [...draftPaths].sort(), includeRecentMessages: draftMessages && recentMessageCount > 0 });
    setOpen(false);
  }

  const selectedCount = selectedPaths.length;
  const selectedMessageCount = includeRecentMessages ? recentMessageCount : 0;
  const hasSelectedContext = selectedCount > 0 || selectedMessageCount > 0;
  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <section className="context-scope-picker" data-testid="context-scope-picker" aria-labelledby="context-scope-heading" aria-busy={loadState === 'loading'}>
        <div className="context-scope-heading-row">
          <div>
            <h3 id="context-scope-heading">Context to send</h3>
            <p className="field-help" data-testid="context-scope-summary">Selected context: {selectedCount} {selectedCount === 1 ? 'file' : 'files'} and {selectedMessageCount} recent {selectedMessageCount === 1 ? 'message' : 'messages'}.</p>
            {!hasSelectedContext ? <p className="field-help" data-testid="context-scope-empty">No project files or recent messages are selected. Only your request will be sent if you approve.</p> : null}
          </div>
          <DialogTrigger asChild>
            <Button type="button" variant="secondary" data-testid="context-scope-open" disabled={disabled} onClick={openPicker}>Choose context</Button>
          </DialogTrigger>
        </div>
        <DialogContent data-testid="context-scope-dialog" aria-labelledby="context-scope-dialog-title">
          <DialogTitle id="context-scope-dialog-title">Choose context to send</DialogTitle>
          <DialogDescription>Select project-relative files and whether to include recent conversation messages. The server applies bounded text and safety checks, then shows the exact final scope before anything is sent.</DialogDescription>
          <div className="context-scope-dialog-body" aria-busy={loadState === 'loading'}>
            <fieldset className="context-scope-message-option">
              <legend>Recent conversation</legend>
              <label className="context-scope-checkbox">
                <input type="checkbox" data-testid="context-recent-messages" checked={draftMessages && recentMessageCount > 0} disabled={recentMessageCount === 0} onChange={(event) => setDraftMessages(event.target.checked)} />
                <span>Include recent messages ({recentMessageCount}{recentMessageCount === 0 ? ' available' : ''})</span>
              </label>
              <p className="field-help">Message bodies stay out of this picker and appear only in the approved server-built request. The latest {recentMessageCount} saved messages are used.</p>
            </fieldset>
            <div className="context-scope-file-section">
              <fieldset>
                <legend className="context-scope-file-legend">Project files</legend>
                {loadState === 'loading' ? <div data-testid="context-file-loading" className="form-status" role="status"><Spinner label="Loading project files" /> Loading project files...</div> : null}
                {loadError ? <Alert tone="error" data-testid="context-file-error" role="alert"><p>{loadError}</p><Button type="button" variant="secondary" onClick={() => { void loadFiles(); }}>Try again</Button></Alert> : null}
                {loadState === 'success' && files.length === 0 ? <div data-testid="context-file-empty"><EmptyState title="No project files found" detail="You can still send only your request or recent messages." /></div> : null}
                {files.length > 0 ? <div id="context-file-list" className="context-file-list" role="group" aria-label="Project files" data-testid="context-file-list">{files.map((file) => <label key={file.path} className="context-scope-checkbox"><input type="checkbox" checked={draftPaths.includes(file.path)} onChange={() => togglePath(file.path)} /><span><code>{file.path}</code><small>{formatBytes(file.sizeBytes)}</small></span></label>)}</div> : null}
              </fieldset>
            </div>
          </div>
          <div className="dialog-actions context-scope-actions">
            <Button type="button" variant="secondary" data-testid="context-scope-cancel" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" data-testid="context-scope-apply" disabled={loadState === 'loading' || Boolean(loadError)} onClick={applySelection}>Use selected context</Button>
          </div>
        </DialogContent>
      </section>
    </DialogRoot>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} bytes`;
  return `${(value / 1024).toFixed(1)} KiB`;
}
