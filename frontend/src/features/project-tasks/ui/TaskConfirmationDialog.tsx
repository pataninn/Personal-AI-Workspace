import { AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogRoot, AlertDialogTitle, Button } from '@/shared/ui';

interface TaskConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly pending: boolean;
  readonly testId: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly error?: string;
}

/** Confirm permanent deletion or suggestion dismissal without losing focus on failure. */
export function TaskConfirmationDialog({ open, title, description, confirmLabel, pending, testId, onOpenChange, onConfirm, error }: TaskConfirmationDialogProps): React.JSX.Element {
  return (
    <AlertDialogRoot open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId} aria-describedby={`${testId}-description`}>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription id={`${testId}-description`}>{description}</AlertDialogDescription>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <AlertDialogCancel asChild><Button type="button" variant="secondary" data-testid={`${testId}-cancel`} disabled={pending}>Cancel</Button></AlertDialogCancel>
          <Button type="button" variant="destructive" data-testid={`${testId}-confirm`} disabled={pending} aria-busy={pending || undefined} onClick={onConfirm}>{pending ? 'Saving…' : confirmLabel}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
