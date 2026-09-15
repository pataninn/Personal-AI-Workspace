export function Skeleton({ className = '' }: { readonly className?: string }): React.JSX.Element {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}
