import type { ReactNode } from 'react';

interface ErrorStateProps {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
  readonly testId?: string;
}

export function ErrorState({ title, detail, action, testId }: ErrorStateProps): React.JSX.Element {
  return (
    <section className="error-state" data-testid={testId} role="alert" aria-labelledby="error-state-title">
      <h1 id="error-state-title">{title}</h1>
      <p>{detail}</p>
      {action}
    </section>
  );
}
