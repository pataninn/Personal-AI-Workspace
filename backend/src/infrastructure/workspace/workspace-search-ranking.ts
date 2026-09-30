export interface WorkspaceSearchQuery {
  readonly phrase: string;
  readonly terms: readonly string[];
}

export interface WorkspaceSearchRelevance {
  readonly score: number;
  readonly column: number;
}

export function createWorkspaceSearchQuery(query: string): WorkspaceSearchQuery {
  const phrase = query.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  const terms = extractWorkspaceSearchTerms(query);
  return { phrase, terms };
}

export function extractWorkspaceSearchTerms(value: string): readonly string[] {
  const splitIdentifiers = value
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2');
  const words = splitIdentifiers.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)];
}

export function rankWorkspaceSearchLine(
  line: string,
  query: WorkspaceSearchQuery,
  fileTerms: ReadonlySet<string>
): WorkspaceSearchRelevance | null {
  const loweredLine = line.toLocaleLowerCase('en-US');
  const phraseIndex = loweredLine.indexOf(query.phrase);
  const lineTerms = new Set(extractWorkspaceSearchTerms(line));
  const matchedTerms = query.terms.filter((term) => lineTerms.has(term));
  if (phraseIndex < 0 && matchedTerms.length === 0) return null;
  const index = phraseIndex >= 0 ? phraseIndex : findEarliestTerm(loweredLine, matchedTerms);
  const score = phraseIndex >= 0 ? 1_000_000 : 0;
  return { score: score + matchedTerms.length * 100 + fileTerms.size * 10, column: toColumn(line, index) };
}

function findEarliestTerm(line: string, terms: readonly string[]): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const term of terms) {
    const index = line.indexOf(term);
    if (index >= 0) earliest = Math.min(earliest, index);
  }
  return earliest === Number.MAX_SAFE_INTEGER ? 0 : earliest;
}

function toColumn(line: string, index: number): number {
  return Array.from(line.slice(0, index)).length + 1;
}
