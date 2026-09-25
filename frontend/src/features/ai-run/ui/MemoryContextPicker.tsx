import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { listProjectFacts, ProjectFactAttribution } from '@/entities/project-fact';
import type { ProjectFact } from '@/entities/project-fact';
import { Alert, Button, DialogContent, DialogDescription, DialogRoot, DialogTitle, DialogTrigger, Skeleton, Spinner } from '@/shared/ui';

interface MemoryContextPickerProps {
  readonly projectId: string;
  readonly selectedFactIds: readonly string[];
  readonly selectedFactVersions: Readonly<Record<string, number>>;
  readonly disabled?: boolean;
  readonly onChange: (factIds: readonly string[], versions: Readonly<Record<string, number>>) => void;
  readonly onReviewStarted: () => void;
  readonly onUnavailable: () => void;
  readonly onSelectionConfirmed: () => void;
  readonly onExplicitSkip: () => void;
}

type LoadState = 'idle' | 'loading' | 'success' | 'error';

/** Usage: Embed in AiRunEntry to let the user select current project facts; only the parent starts a run after a separate consent step. */
export function MemoryContextPicker({ projectId, selectedFactIds, selectedFactVersions, disabled = false, onChange, onReviewStarted, onUnavailable, onSelectionConfirmed, onExplicitSkip }: MemoryContextPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [facts, setFacts] = useState<readonly ProjectFact[]>([]);
  const [draftFactIds, setDraftFactIds] = useState<readonly string[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [driftMessage, setDriftMessage] = useState('');
  const [selectionMessage, setSelectionMessage] = useState('');
  const requestIdRef = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    requestIdRef.current += 1;
    setOpen(false);
    setFacts([]);
    setLoadState('idle');
    setDraftFactIds([]);
    setErrorMessage('');
    setDriftMessage('');
    setSelectionMessage('');
  }, [projectId]);

  function openPicker(): void {
    setOpen(true);
    setDraftFactIds([...selectedFactIds]);
    setDriftMessage('');
    setSelectionMessage('');
    if (selectedFactIds.length > 0) {
      onReviewStarted();
    }
    void loadFacts();
  }

  async function loadFacts(): Promise<void> {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoadState('loading');
    setFacts([]);
    setErrorMessage('');
    try {
      const loaded = await listProjectFacts(projectId);
      if (requestId !== requestIdRef.current || projectIdRef.current !== projectId) {
        return;
      }
      const factsById = new Map(loaded.map((fact) => [fact.id, fact]));
      const validSelectedIds = selectedFactIds.filter((id) => factsById.get(id)?.version === selectedFactVersions[id]);
      if (validSelectedIds.length !== selectedFactIds.length) {
        setDriftMessage('A selected fact changed or is no longer active. Review the current facts before selecting again.');
        const versions = Object.fromEntries(validSelectedIds.map((id) => [id, factsById.get(id)?.version ?? 0]));
        onChange(validSelectedIds, versions);
      }
      setFacts(loaded);
      setDraftFactIds(validSelectedIds);
      setLoadState('success');
    } catch {
      if (requestId !== requestIdRef.current || projectIdRef.current !== projectId) {
        return;
      }
      setLoadState('error');
      setErrorMessage('Project memory could not be loaded for this run. Retry or explicitly continue without project memory.');
      onUnavailable();
    }
  }

  function toggleFact(factId: string): void {
    setDraftFactIds((current) => current.includes(factId) ? current.filter((id) => id !== factId) : [...current, factId]);
  }

  function applySelection(): void {
    const selected = facts.filter((fact) => draftFactIds.includes(fact.id));
    onChange(selected.map((fact) => fact.id), Object.fromEntries(selected.map((fact) => [fact.id, fact.version])));
    onSelectionConfirmed();
    setSelectionMessage('Project memory selection saved for this run.');
    setOpen(false);
  }

  function continueWithoutMemory(): void {
    onChange([], {});
    onSelectionConfirmed();
    onExplicitSkip();
    setSelectionMessage('Continuing without project memory for this run.');
    setOpen(false);
  }

  const selectedFacts = facts.filter((fact) => selectedFactIds.includes(fact.id));
  const countLabel = `${selectedFactIds.length} ${selectedFactIds.length === 1 ? 'fact' : 'facts'} selected`;
  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <section className="memory-context-picker" data-testid="memory-context-picker" aria-labelledby="memory-context-heading">
        <div className="memory-context-heading-row">
          <div>
            <h3 id="memory-context-heading">Project memory</h3>
            <p className="field-help">Choose which saved facts to include in this run. Nothing is sent until you approve the provider disclosure.</p>
            <p className="field-help" data-testid="memory-context-count">{countLabel}</p>
          </div>
          <DialogTrigger asChild><Button type="button" variant="secondary" data-testid="memory-context-open" disabled={disabled} onClick={openPicker}>Choose facts</Button></DialogTrigger>
        </div>
        {driftMessage ? <Alert tone="warning" data-testid="memory-context-drift">{driftMessage}</Alert> : null}
        {selectionMessage ? <p className="form-status" role="status" aria-live="polite">{selectionMessage}</p> : null}
        {loadState === 'error' && !open ? <Alert tone="error" data-testid="memory-context-load-error" role="alert"><p>{errorMessage}</p><div className="memory-context-error-actions"><Button type="button" variant="secondary" data-testid="memory-context-load-error-retry" onClick={() => { setOpen(true); void loadFacts(); }}>Try again</Button><Button type="button" data-testid="memory-context-load-error-continue-without" onClick={continueWithoutMemory}>Continue without project memory</Button></div></Alert> : null}
        {selectedFacts.length > 0 ? <ul className="memory-context-selection" aria-label="Selected project facts">{selectedFacts.map((fact) => <li key={fact.id}><strong>{fact.title}</strong><p className="memory-fact-value">{fact.content}</p></li>)}</ul> : null}
        {loadState === 'success' && facts.length === 0 ? <p className="field-help" data-testid="memory-context-empty">No saved facts for this project. <Link data-testid="memory-context-manage-link" to={`/projects/${encodeURIComponent(projectId)}/memory`}>Manage project memory</Link></p> : null}
        <DialogContent data-testid="memory-context-dialog" aria-busy={loadState === 'loading' || undefined}>
          <DialogTitle>Project memory</DialogTitle>
          <DialogDescription>Choose facts for this run. They stay unchecked until you select them, and the exact outbound text appears in the provider disclosure before transmission.</DialogDescription>
          <p className="field-help">{countLabel}</p>
          {driftMessage ? <Alert tone="warning">{driftMessage}</Alert> : null}
          {loadState === 'loading' ? <div className="memory-context-loading" data-testid="memory-context-loading" aria-busy="true"><p role="status"><Spinner label="Loading project memory" /> Loading project memory…</p><Skeleton className="memory-fact-skeleton" /><Skeleton className="memory-fact-skeleton" /></div> : null}
          {loadState === 'error' ? <Alert tone="error" data-testid="memory-context-dialog-error" role="alert"><p>{errorMessage}</p><div className="memory-context-error-actions"><Button type="button" variant="secondary" data-testid="memory-context-dialog-retry" onClick={() => { void loadFacts(); }}>Try again</Button><Button type="button" data-testid="memory-context-dialog-continue-without" onClick={continueWithoutMemory}>Continue without project memory</Button></div></Alert> : null}
          {loadState === 'success' && facts.length === 0 ? <section className="memory-context-empty" data-testid="memory-context-empty-state" aria-labelledby="memory-context-empty-title"><h3 id="memory-context-empty-title">No saved facts for this project</h3><p>Add facts in project memory, then choose which ones to include in a run.</p><Link data-testid="memory-context-empty-manage-link" className="button button-secondary" to={`/projects/${encodeURIComponent(projectId)}/memory`}>Manage project memory</Link></section> : null}
          {loadState === 'success' && facts.length > 0 ? <fieldset className="memory-context-fact-list"><legend>Available project facts</legend>{facts.map((fact) => <label key={fact.id} className="memory-context-fact">
            <input type="checkbox" data-testid={`memory-context-fact-${fact.id}`} checked={draftFactIds.includes(fact.id)} aria-describedby={fact.verificationStatus === 'needs_review' ? `memory-context-review-${fact.id}` : undefined} onChange={() => toggleFact(fact.id)} />
            <span className="memory-context-fact-body"><strong>{fact.title}</strong><span className="memory-fact-value">{fact.content}</span><ProjectFactAttribution fact={fact} />{fact.verificationStatus === 'needs_review' ? <span id={`memory-context-review-${fact.id}`} className="memory-context-review-note">Needs review. Check this value before including it.</span> : null}</span>
          </label>)}</fieldset> : null}
          <div className="dialog-actions memory-context-actions">
            <Button type="button" variant="secondary" data-testid="memory-context-cancel" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" data-testid="memory-context-apply" disabled={loadState !== 'success'} onClick={applySelection}>Use selected facts</Button>
          </div>
        </DialogContent>
      </section>
    </DialogRoot>
  );
}
