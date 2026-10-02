import { ModelProviderOutputError } from '@/modules/ai-runs/domain/model-provider-errors';

/** Finds a single output envelope without interpreting surrounding prose as file content. */
export function extractProviderEnvelope(text: string): string | null {
  if (text.startsWith('{')) return text;
  const openings = /\{\s*"(?:message|text|changes|proposedChanges|taskSuggestions)"\s*:/gu;
  let envelope: string | null = null;
  let opening: RegExpExecArray | null;
  while ((opening = openings.exec(text)) !== null) {
    const end = findObjectEnd(text, opening.index);
    if (end === null || envelope !== null) throw new ModelProviderOutputError();
    envelope = text.slice(opening.index, end);
    openings.lastIndex = end;
  }
  return envelope;
}

function findObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}
