import { useEffect, useRef, useState, type FormEvent } from 'react';

import { flattenWorkspaceFiles, getWorkspaceTree, searchWorkspaceFiles, type WorkspaceFileCandidate, type WorkspaceFileSearchMatch } from '@/entities/workspace';
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
const MAX_CONTEXT_PATHS = 100;
const MAX_SEARCH_RESULTS = 50;

export function ContextScopePicker({ projectId, selectedPaths, includeRecentMessages, recentMessageCount, disabled = false, onChange }: ContextScopePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [files, setFiles] = useState<readonly WorkspaceFileCandidate[]>([]);
  const [fileProjectId, setFileProjectId] = useState<string | null>(null);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [searchState, setSearchState] = useState<LoadState>('idle');
  const [searchProjectId, setSearchProjectId] = useState<string | null>(null);
  const [searchMatches, setSearchMatches] = useState<readonly WorkspaceFileSearchMatch[]>([]);
  const [searchFilesScanned, setSearchFilesScanned] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [draftPaths, setDraftPaths] = useState<readonly string[]>(selectedPaths);
  const [draftMessages, setDraftMessages] = useState(includeRecentMessages);
  const fileLoadRequestSequence = useRef(0);
  const searchRequestSequence = useRef(0);

  useEffect(() => {
    fileLoadRequestSequence.current += 1;
    searchRequestSequence.current += 1;
    setLoadState('idle');
    setFileProjectId(null);
    setFiles([]);
    setTreeTruncated(false);
    setLoadError(null);
    setSearchQuery('');
    setSubmittedQuery('');
    setSearchState('idle');
    setSearchProjectId(null);
    setSearchMatches([]);
    setSearchFilesScanned(0);
    setSearchTruncated(false);
    setSearchError(null);
  }, [projectId]);

  useEffect(() => {
    if (open) {
      setDraftPaths(selectedPaths);
      setDraftMessages(includeRecentMessages);
    }
  }, [includeRecentMessages, open, selectedPaths]);

  function openPicker(): void {
    setOpen(true);
    if (fileProjectId !== projectId || loadState === 'idle' || loadState === 'error') {
      void loadFiles();
    }
  }

  async function loadFiles(): Promise<void> {
    const requestSequence = fileLoadRequestSequence.current + 1;
    fileLoadRequestSequence.current = requestSequence;
    setLoadState('loading');
    setFileProjectId(projectId);
    setLoadError(null);
    try {
      const tree = await getWorkspaceTree(projectId);
      if (fileLoadRequestSequence.current !== requestSequence) return;
      const nextFiles = flattenWorkspaceFiles(tree);
      setFiles(nextFiles);
      setTreeTruncated(tree.truncated || nextFiles.length >= 500);
      setLoadState('success');
    } catch {
      if (fileLoadRequestSequence.current !== requestSequence) return;
      setLoadState('error');
      setLoadError('Project files could not be loaded safely. Try again before selecting context.');
    }
  }

  async function runSearch(): Promise<void> {
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchState('error');
      setSearchError('Enter a word or phrase to search project files.');
      return;
    }
    setSearchState('loading');
    setSearchProjectId(projectId);
    setSearchError(null);
    setSubmittedQuery(query);
    const requestSequence = searchRequestSequence.current + 1;
    searchRequestSequence.current = requestSequence;
    try {
      const result = await searchWorkspaceFiles(projectId, query, MAX_SEARCH_RESULTS);
      if (searchRequestSequence.current !== requestSequence) return;
      setSearchProjectId(projectId);
      setSearchMatches(result.matches);
      setSearchFilesScanned(result.filesScanned);
      setSearchTruncated(result.truncated);
      setSearchState('success');
    } catch {
      if (searchRequestSequence.current !== requestSequence) return;
      setSearchProjectId(projectId);
      setSearchState('error');
      setSearchError('Project search could not be completed safely. Try again.');
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void runSearch();
  }

  function togglePath(path: string): void {
    setDraftPaths((current) => {
      if (current.includes(path)) return current.filter((candidate) => candidate !== path);
      return current.length >= MAX_CONTEXT_PATHS ? current : [...current, path].sort();
    });
  }

  function applySelection(): void {
    onChange({ relativePaths: [...draftPaths].sort(), includeRecentMessages: draftMessages && recentMessageCount > 0 });
    setOpen(false);
  }

  const selectedCount = selectedPaths.length;
  const currentTreeReady = fileProjectId === projectId && loadState === 'success';
  const currentTreeLoading = fileProjectId === projectId && loadState === 'loading';
  const currentLoadError = fileProjectId === projectId ? loadError : null;
  const currentTreeTruncated = fileProjectId === projectId && treeTruncated;
  const currentFiles = fileProjectId === projectId ? files : [];
  const currentSearchLoading = searchProjectId === projectId && searchState === 'loading';
  const currentSearchError = searchProjectId === projectId ? searchError : null;
  const showSearchResults = searchProjectId === projectId && searchState === 'success';
  const searchFiles = distinctSearchFiles(showSearchResults ? searchMatches : []);
  const selectedMessageCount = includeRecentMessages ? recentMessageCount : 0;
  const hasSelectedContext = selectedCount > 0 || selectedMessageCount > 0;
  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <section className="context-scope-picker" data-testid="context-scope-picker" aria-labelledby="context-scope-heading" aria-busy={currentTreeLoading || currentSearchLoading}>
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
          <div className="context-scope-dialog-body" aria-busy={currentTreeLoading || currentSearchLoading}>
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
                {currentTreeLoading ? <div data-testid="context-file-loading" className="form-status" role="status"><Spinner label="Loading project files" /> Loading project files...</div> : null}
                {currentLoadError ? <Alert tone="error" data-testid="context-file-error" role="alert"><p>{currentLoadError}</p><Button type="button" variant="secondary" onClick={() => { void loadFiles(); }}>Try again</Button></Alert> : null}
                {currentTreeTruncated ? <p className="field-help" data-testid="context-tree-truncated" role="status">The file browser shows a limited list. Search can find files outside this list.</p> : null}
                <form className="context-file-search" onSubmit={submitSearch} role="search" aria-label="Search project files">
                  <label htmlFor="context-file-search-query">Search project files</label>
                  <div className="context-file-search-controls">
                    <input id="context-file-search-query" type="search" data-testid="context-file-search-query" maxLength={256} value={searchQuery} disabled={disabled || currentSearchLoading} onChange={(event) => setSearchQuery(event.target.value)} aria-describedby="context-file-search-help" />
                    <Button type="submit" variant="secondary" data-testid="context-file-search-submit" disabled={disabled || currentSearchLoading}>{currentSearchLoading ? 'Searching...' : 'Search'}</Button>
                    {searchProjectId === projectId && submittedQuery ? <Button type="button" variant="secondary" data-testid="context-file-search-clear" disabled={currentSearchLoading} onClick={() => { searchRequestSequence.current += 1; setSearchQuery(''); setSubmittedQuery(''); setSearchState('idle'); setSearchProjectId(null); setSearchMatches([]); setSearchTruncated(false); setSearchError(null); }}>Clear search</Button> : null}
                  </div>
                  <p id="context-file-search-help" className="field-help">Search checks readable project text locally. Results stay unchecked until you select them.</p>
                </form>
                {currentSearchLoading ? <p className="form-status" role="status" data-testid="context-search-loading"><Spinner label="Searching project files" /> Searching up to the local safety limits...</p> : null}
                {currentSearchError ? <Alert tone="error" role="alert" data-testid="context-search-error"><p>{currentSearchError}</p><Button type="button" variant="secondary" disabled={currentSearchLoading} onClick={() => { void runSearch(); }}>Retry search</Button></Alert> : null}
                {showSearchResults ? <div className="context-search-results" data-testid="context-search-results">
                  <p className="field-help" role="status" aria-live="polite">{searchFiles.length} matching {searchFiles.length === 1 ? 'file' : 'files'} from a bounded scan of {searchFilesScanned} file candidates for “{submittedQuery}”.</p>
                  {searchTruncated ? <p className="context-search-truncated" data-testid="context-search-truncated" role="status">Some matches may be missing because project search is bounded.</p> : null}
                  {searchFiles.length === 0 ? <EmptyState title="No matching files found" detail="Try a different word or phrase. Only readable text files are searched." /> : <ul className="context-file-list context-search-file-list" aria-label="Ranked matching project files">{searchFiles.map((match) => {
                    const checked = draftPaths.includes(match.path);
                    return <li key={match.path}><label className="context-scope-checkbox"><input type="checkbox" data-testid="context-search-result-checkbox" checked={checked} disabled={disabled || (!checked && draftPaths.length >= MAX_CONTEXT_PATHS)} onChange={() => togglePath(match.path)} /><span><code>{match.path}</code><small>Line {match.line}: {match.text}</small></span></label></li>;
                  })}</ul>}
                </div> : null}
                <p className="field-help" data-testid="context-file-selection-count" role="status" aria-live="polite">{draftPaths.length} of {MAX_CONTEXT_PATHS} project files selected.</p>
                {draftPaths.length >= MAX_CONTEXT_PATHS ? <p className="field-help" data-testid="context-file-selection-limit">Remove a selected file before choosing another.</p> : null}
                {currentTreeReady && currentFiles.length === 0 ? <div data-testid="context-file-empty"><EmptyState title="No project files found" detail="You can still send only your request or recent messages." /></div> : null}
                {currentFiles.length > 0 ? <div id="context-file-list" className="context-file-list" role="group" aria-label="Browse project files" data-testid="context-file-list">{currentFiles.map((file) => {
                  const checked = draftPaths.includes(file.path);
                  return <label key={file.path} className="context-scope-checkbox"><input type="checkbox" checked={checked} disabled={disabled || (!checked && draftPaths.length >= MAX_CONTEXT_PATHS)} onChange={() => togglePath(file.path)} /><span><code>{file.path}</code><small>{formatBytes(file.sizeBytes)}</small></span></label>;
                })}</div> : null}
              </fieldset>
            </div>
          </div>
          <div className="dialog-actions context-scope-actions">
            <Button type="button" variant="secondary" data-testid="context-scope-cancel" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" data-testid="context-scope-apply" disabled={currentTreeLoading || (Boolean(currentLoadError) && !showSearchResults)} onClick={applySelection}>Use selected context</Button>
          </div>
        </DialogContent>
      </section>
    </DialogRoot>
  );
}

function distinctSearchFiles(matches: readonly WorkspaceFileSearchMatch[]): readonly WorkspaceFileSearchMatch[] {
  const seen = new Set<string>();
  const unique: WorkspaceFileSearchMatch[] = [];
  for (const match of matches) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    unique.push(match);
  }
  return unique;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} bytes`;
  return `${(value / 1024).toFixed(1)} KiB`;
}
