export function TypingIndicator({ testId = 'assistant-typing' }: { readonly testId?: string }): React.JSX.Element {
  return <span className="assistant-run-indicator assistant-run-typing" role="status" aria-label="Assistant is working" data-testid={testId}><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></span>;
}
