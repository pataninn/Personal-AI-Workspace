import { Slot } from '@radix-ui/react-slot';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly asChild?: boolean;
  readonly children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, children, className, variant = 'primary', ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component ref={ref} className={cn('button', `button-${variant}`, className)} {...props}>
        {children}
      </Component>
    );
  }
);
Button.displayName = 'Button';
