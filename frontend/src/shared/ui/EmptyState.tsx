import type { ReactNode } from 'react';

interface EmptyStateProps {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
  readonly testId?: string;
}

export function EmptyState({ title, detail, action, testId }: EmptyStateProps): React.JSX.Element {
  return (
    <section className="empty-state" data-testid={testId} aria-labelledby="empty-state-title">
      <h1 id="empty-state-title">{title}</h1>
      <p>{detail}</p>
      {action}
    </section>
  );
}
