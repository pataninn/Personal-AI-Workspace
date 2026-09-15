import { Outlet } from 'react-router-dom';

import { AuthProvider } from '@/app/providers/AuthProvider';
import '@/app/styles/globals.css';

export function App(): React.JSX.Element {
  return (
    <>
      {import.meta.env.MODE === 'preview' ? (
        <div className="preview-notice" data-testid="preview-notice" role="status">
          Preview mode: mock data only; no real workspace or AI connection
        </div>
      ) : null}
      <AuthProvider><Outlet /></AuthProvider>
    </>
  );
}
