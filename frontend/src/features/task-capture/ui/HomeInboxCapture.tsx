import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { createInboxTask, getInboxTaskCount } from '@/entities/project-task';
import { selectCsrfToken } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Card, Input, Label } from '@/shared/ui';

interface HomeInboxCaptureProps {
  readonly onCreated?: () => void;
}

interface CaptureIntent {
  readonly title: string;
  readonly idempotencyKey: string;
}

export function HomeInboxCapture({ onCreated }: HomeInboxCaptureProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const titleRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<CaptureIntent | null>(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [countStatus, setCountStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [countAttempt, setCountAttempt] = useState(0);

  const refreshCount = useCallback(async (): Promise<void> => {
    setCountStatus('loading');
    try {
      const result = await getInboxTaskCount();
      setCount(result.count);
      setCountStatus('ready');
    } catch {
      setCountStatus('error');
    }
  }, []);

  useEffect(() => { void refreshCount(); }, [countAttempt, refreshCount]);
  useEffect(() => { if (savedTaskId) titleRef.current?.focus(); }, [savedTaskId]);

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (saving) return;
    const normalizedTitle = title.trim();
    if (!normalizedTitle || Array.from(normalizedTitle).length > 120) {
      setTitleError('Enter a task title of 1 to 120 characters.');
      titleRef.current?.focus();
      return;
    }
    setTitleError(null);
    setSavedTaskId(null);
    const intent = intentRef.current ?? { title: normalizedTitle, idempotencyKey: crypto.randomUUID() };
    intentRef.current = intent;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await createInboxTask(intent.title, csrfToken ?? '', intent.idempotencyKey);
      intentRef.current = null;
      setTitle('');
      setSavedTaskId(result.item.task.id);
      await refreshCount();
      onCreated?.();
      titleRef.current?.focus();
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode >= 400 && error.statusCode < 500) {
        intentRef.current = null;
        setTitleError(error.statusCode === 400 ? 'Check the task title and try again.' : null);
      }
      setSaveError('The task could not be saved. Retry to safely check the same request.');
    } finally {
      setSaving(false);
    }
  }

  const unresolved = saveError !== null && intentRef.current !== null;
  return <Card className="home-inbox-capture" data-testid="home-inbox-capture">
    <header className="home-section-heading">
      <div><h2>Inbox</h2><p className="supporting-copy">Capture it now. You can organize it later.</p></div>
      <span className="reference-count" aria-label={countStatus === 'ready' ? `${count} Inbox tasks` : undefined} data-testid="home-inbox-count">
        {countStatus === 'ready' ? String(count).padStart(2, '0') : countStatus === 'loading' ? '…' : '—'}
      </span>
    </header>
    {countStatus === 'loading' ? <p className="sr-only" role="status">Loading Inbox count</p> : null}
    {countStatus === 'error' ? <p className="supporting-copy" data-testid="home-inbox-count-error">Count unavailable. <button type="button" className="text-link" onClick={() => { setCountAttempt((value) => value + 1); }}>Try again</button></p> : null}
    {countStatus === 'ready' ? <p className="supporting-copy"><Link to="/tasks?inboxOnly=true">View Inbox</Link> or <Link to="/tasks">All tasks</Link></p> : <p className="supporting-copy"><Link to="/tasks">All tasks</Link></p>}
    <form className="home-inbox-capture-form" onSubmit={(event) => { void submit(event); }} noValidate>
      <div className="min-w-0 flex-1">
        <Label htmlFor="home-inbox-title">Task title</Label>
        <Input ref={titleRef} id="home-inbox-title" data-testid="home-inbox-title" value={title} maxLength={240} disabled={saving || unresolved}
          aria-invalid={Boolean(titleError)} aria-describedby={titleError ? 'home-inbox-title-error' : 'home-inbox-title-help'}
          onChange={(event) => { setTitle(event.currentTarget.value); setTitleError(null); setSaveError(null); setSavedTaskId(null); }} />
        {titleError ? <p id="home-inbox-title-error" className="field-error" role="alert">{titleError}</p> : <p id="home-inbox-title-help" className="supporting-copy">You can organize it later.</p>}
      </div>
      <Button type="submit" data-testid="home-inbox-save" disabled={saving || unresolved || !title.trim()}>{saving ? 'Saving…' : 'Save to Inbox'}</Button>
    </form>
    <p className="sr-only" role="status" aria-live="polite">{saving ? 'Saving…' : savedTaskId ? 'Saved to Inbox' : ''}</p>
    {saveError ? <Alert tone="error" role="alert" data-testid="home-inbox-save-error"><p>{saveError}</p>{unresolved ? <Button type="button" variant="secondary" data-testid="home-inbox-retry" onClick={() => { void submit(); }}>Retry save</Button> : null}</Alert> : null}
    {savedTaskId ? <p className="supporting-copy" data-testid="home-inbox-saved"><strong>Saved to Inbox.</strong> <Link to={`/tasks/${encodeURIComponent(savedTaskId)}`}>View task</Link></p> : null}
    {countStatus === 'ready' && count === 0 ? <p className="supporting-copy" data-testid="home-inbox-empty">Inbox is empty. Capture a task now and sort it later.</p> : null}
  </Card>;
}
