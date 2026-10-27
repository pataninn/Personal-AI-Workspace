import { Navigate } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { selectPrincipal } from '@/entities/user-session';
import { ShowcasePublisher } from '@/features/showcase-publishing';

export function AdminShowcasePage(): React.JSX.Element {
  const principal = useAppSelector(selectPrincipal);
  if (principal?.role !== 'admin' || principal.accountKind !== 'regular') {
    return <Navigate to="/dashboard" replace />;
  }
  return <ShowcasePublisher />;
}
