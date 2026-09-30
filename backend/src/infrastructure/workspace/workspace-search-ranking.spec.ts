import {
  createWorkspaceSearchQuery,
  extractWorkspaceSearchTerms,
  rankWorkspaceSearchLine
} from '@/infrastructure/workspace/workspace-search-ranking';

describe('workspace search ranking', () => {
  it('matches phrases without case sensitivity and ranks them ahead of token matches', () => {
    const query = createWorkspaceSearchQuery('Project task');
    const fileTerms = new Set(['project', 'task', 'suggestion']);
    const phrase = rankWorkspaceSearchLine('A PROJECT TASK is queued.', query, fileTerms);
    const tokens = rankWorkspaceSearchLine('Project notes describe a task.', query, fileTerms);

    expect(phrase?.score).toBeGreaterThan(tokens?.score ?? 0);
    expect(phrase?.column).toBe(3);
  });

  it('recognizes query terms across camel-case identifiers and ignores duplicates', () => {
    expect(extractWorkspaceSearchTerms('ProjectTaskSuggestion Project task')).toEqual(['project', 'task', 'suggestion']);
    const query = createWorkspaceSearchQuery('task suggestion');
    const relevance = rankWorkspaceSearchLine('saveProjectTaskSuggestion()', query, new Set(['project', 'task', 'suggestion']));

    expect(relevance).toEqual({ score: 230, column: 12 });
  });

  it('does not match a multi-word query when none of its terms occur', () => {
    const query = createWorkspaceSearchQuery('project task');

    expect(rankWorkspaceSearchLine('conversation history', query, new Set())).toBeNull();
  });
});
