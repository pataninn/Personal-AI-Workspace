import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '@/shared/lib/cn';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn('input textarea', className)} {...props} />
);
Textarea.displayName = 'Textarea';
