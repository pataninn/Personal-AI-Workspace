import { useEffect, useState } from 'react';
import { flattenWorkspaceFiles, getWorkspaceTree } from '@/entities/workspace';

const SUFFIXES = new Set('md markdown txt rst adoc csv tsv json jsonl yaml yml toml ini conf cfg xml html htm css scss sass less js jsx mjs cjs ts tsx vue svelte py ipynb rb php go rs c h cpp hpp cs java kt swift sh bash zsh ps1 sql graphql gql proto tex r rmd lua ex exs erl hs clj cljc edn scala dart bat cmd svg pdf'.split(' '));
const FILENAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'procfile', '.gitignore', '.editorconfig']);

/** Load document/code paths without changing the independent AI context choices. */
export function useProjectFiles(projectId: string, enabled = true) {
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setPaths([]); setLoading(false); setError(null); setLimited(false);
      return;
    }
    let current = true;
    setLoading(true); setError(null);
    void getWorkspaceTree(projectId, 6).then((tree) => {
      if (!current) return;
      const files = flattenWorkspaceFiles(tree);
      setPaths(files.map((file) => file.path).filter(isSupportedDocument).sort((a, b) => a.localeCompare(b)));
      setLimited(tree.truncated || files.length >= 500); setLoading(false);
    }).catch((failure: unknown) => {
      if (current) { setError(failure instanceof Error ? failure.message : 'Files could not be loaded.'); setLoading(false); }
    });
    const refresh = (): void => { setAttempt((value) => value + 1); };
    window.addEventListener('project-files-changed', refresh);
    return () => { current = false; window.removeEventListener('project-files-changed', refresh); };
  }, [enabled, projectId, attempt]);
  return { paths, loading, error, limited, refresh: (): void => { setAttempt((value) => value + 1); } };
}

export function isSupportedDocument(filePath: string): boolean {
  const name = filePath.split('/').at(-1)?.toLowerCase() ?? '';
  return FILENAMES.has(name) || SUFFIXES.has(name.split('.').at(-1) ?? '');
}
