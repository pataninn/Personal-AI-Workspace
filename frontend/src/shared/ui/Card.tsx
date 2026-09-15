import type { HTMLAttributes } from 'react';

import { cn } from '@/shared/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('card', className)} {...props} />;
}
