import { Alert, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button } from '@/shared/ui';
import type { ProjectFact } from '@/entities/project-fact';

interface ProjectFactDeleteDialogProps {
  readonly fact: ProjectFact | null;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly conflict: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDelete: () => void;
}

/** Usage: Mount from ProjectMemoryManager; pass the selected fact and keep deletion/version checks in its callbacks. */
export function ProjectFactDeleteDialog({ fact, deleting, error, conflict, onOpenChange, onDelete }: ProjectFactDeleteDialogProps): React.JSX.Element {
  const open = fact !== null;
  return (
    <AlertDialogRoot open={open} onOpenChange={(nextOpen) => !deleting && onOpenChange(nextOpen)}>
      <AlertDialogContent data-testid="project-fact-delete-dialog" aria-busy={deleting || undefined}>
        <AlertDialogTitle>Delete this fact?</AlertDialogTitle>
        <AlertDialogDescription>{fact ? <>This removes “{fact.title}” from active project memory. It will not be available for future context selection.</> : null}</AlertDialogDescription>
        {fact ? <div className="project-fact-delete-preview"><strong>{fact.title}</strong><p className="memory-fact-value">{preview(fact.content)}</p></div> : null}
        {conflict ? <Alert tone="warning" data-testid="project-fact-delete-conflict">This fact changed while the delete dialog was open. Review the latest value above before confirming deletion.</Alert> : null}
        {error ? <Alert tone="error" data-testid="project-fact-delete-error" role="alert">{error}</Alert> : null}
        {deleting ? <p className="form-status" role="status" aria-live="polite">Deleting…</p> : null}
        <div className="dialog-actions">
          <Button type="button" variant="secondary" data-testid="project-fact-delete-cancel" disabled={deleting} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="destructive" data-testid="project-fact-delete-confirm" aria-busy={deleting} disabled={deleting || !fact} onClick={onDelete}>{deleting ? 'Deleting…' : 'Delete fact'}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}

function preview(content: string): string {
  return content.length > 240 ? `${content.slice(0, 240)}…` : content;
}
