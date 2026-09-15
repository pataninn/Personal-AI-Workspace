import * as RadixLabel from '@radix-ui/react-label';
import type { ComponentPropsWithoutRef } from 'react';

export function Label(props: ComponentPropsWithoutRef<typeof RadixLabel.Root>): React.JSX.Element {
  return <RadixLabel.Root className="field-label" {...props} />;
}
