import type { HTMLAttributes } from 'react';

import { cn } from '@/shared/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('card min-w-0 [&>h2]:m-0 [&>h3]:m-0 [&>p]:m-0', className)} {...props} />;
}
