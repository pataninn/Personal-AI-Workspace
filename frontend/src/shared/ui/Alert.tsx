import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

type AlertTone = 'info' | 'success' | 'warning' | 'error';

interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: AlertTone;
  readonly children: ReactNode;
  readonly live?: 'polite' | 'assertive' | 'off';
}

export function Alert({ children, className, live = 'off', role, tone = 'info', ...props }: AlertProps): React.JSX.Element {
  return (
    <div
      className={cn('alert', `alert-${tone}`, className)}
      role={role ?? (tone === 'error' ? 'alert' : undefined)}
      aria-live={live === 'off' ? undefined : live}
      {...props}
    >
      {children}
    </div>
  );
}
