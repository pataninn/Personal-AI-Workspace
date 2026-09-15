export function Spinner({ label = 'Loading' }: { readonly label?: string }): React.JSX.Element {
  return <span className="spinner" aria-label={label} role="status" />;
}
