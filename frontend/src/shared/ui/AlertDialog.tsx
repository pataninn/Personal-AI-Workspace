import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/shared/lib/cn';

export const AlertDialogRoot = DialogPrimitive.Root;
export const AlertDialogTrigger = DialogPrimitive.Trigger;
export const AlertDialogClose = DialogPrimitive.Close;
export const AlertDialogCancel = DialogPrimitive.Close;

export function AlertDialogContent({ className, onInteractOutside, onPointerDownOutside, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-scrim" />
      <DialogPrimitive.Content
        {...props}
        role="alertdialog"
        className={cn('dialog-content', className)}
        onInteractOutside={(event) => {
          event.preventDefault();
          onInteractOutside?.(event);
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
          onPointerDownOutside?.(event);
        }}
      />
    </DialogPrimitive.Portal>
  );
}

export const AlertDialogTitle = DialogPrimitive.Title;
export const AlertDialogDescription = DialogPrimitive.Description;

