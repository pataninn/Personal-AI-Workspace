import type { AiRunEvent } from '@/entities/ai-run';

export function HermesToolActivity({ events }: { readonly events: readonly AiRunEvent[] }): React.JSX.Element | null {
  const tools = new Map<string, { readonly title: string; readonly status: string }>();
  for (const event of events) {
    if (event.type !== 'tool.progress') continue;
    const { toolId, title, status } = event.payload;
    if (typeof toolId === 'string' && typeof title === 'string' && typeof status === 'string') tools.set(toolId, { title, status });
  }
  if (tools.size === 0) return null;
  return <section aria-label="Activity">
    {tools.size > 0 ? <ul aria-label="Recent tools">{[...tools.entries()].slice(-8).map(([id, tool]) => <li key={id}>{tool.title} — {tool.status}</li>)}</ul> : null}
  </section>;
}
