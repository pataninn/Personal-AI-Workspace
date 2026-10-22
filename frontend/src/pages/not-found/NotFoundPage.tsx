import { Link } from 'react-router-dom';

import { ErrorState } from '@/shared/ui';

export function NotFoundPage(): React.JSX.Element {
  return (
    <ErrorState
      testId="not-found-state"
      title="Page not found"
      detail="This page may have moved or no longer exists."
      action={<Link className="button button-secondary" data-testid="back-to-workspace-link" to="/dashboard">Back to workspace</Link>}
    />
  );
}
