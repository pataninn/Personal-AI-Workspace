import type { AiRunEvent } from '@/entities/ai-run';

export function HermesToolActivity({ events }: { readonly events: readonly AiRunEvent[] }): React.JSX.Element {
  const tools = new Map<string, { readonly title: string; readonly status: string }>();
  for (const event of events) {
    if (event.type !== 'tool.progress') continue;
    const { toolId, title, status } = event.payload;
    if (typeof toolId === 'string' && typeof title === 'string' && typeof status === 'string') tools.set(toolId, { title, status });
  }
  return <section aria-label="Hermes activity">
    <p className="field-help">Hermes · isolated project copy · skills: frontend design, existing project editing, clarify and plan</p>
    {tools.size > 0 ? <ul aria-label="Recent tools">{[...tools.entries()].slice(-8).map(([id, tool]) => <li key={id}>{tool.title} — {tool.status}</li>)}</ul> : null}
  </section>;
}
