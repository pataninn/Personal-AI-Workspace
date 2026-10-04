import { useState } from 'react';
import { ProjectFileViewer } from '@/features/project-files/ui/ProjectFileViewer';

interface TreeNode { readonly name: string; readonly path: string; readonly children: Map<string, TreeNode> }

function buildTree(paths: readonly string[]): readonly TreeNode[] {
  const roots = new Map<string, TreeNode>();
  for (const filePath of paths) {
    let children = roots;
    const segments = filePath.split('/');
    for (let index = 0; index < segments.length; index++) {
      const name = segments[index];
      if (!name) continue;
      let node = children.get(name);
      if (!node) { node = { name, path: segments.slice(0, index + 1).join('/'), children: new Map() }; children.set(name, node); }
      children = node.children;
    }
  }
  return [...roots.values()];
}

/** Collapsed folders and lazy file reads keep large projects inexpensive to browse. */
export function ProjectFileTree({ projectId, paths, onChanged }: { readonly projectId: string; readonly paths: readonly string[]; readonly onChanged: () => void }): React.JSX.Element {
  return <ul className="file-tree" data-testid="project-file-list">{buildTree(paths).map((node) => <FileTreeNode key={node.path} node={node} projectId={projectId} onChanged={onChanged} />)}</ul>;
}

function FileTreeNode({ node, projectId, onChanged }: { readonly node: TreeNode; readonly projectId: string; readonly onChanged: () => void }): React.JSX.Element {
  const [visited, setVisited] = useState(false);
  if (node.children.size > 0) return <li><details className="file-folder"><summary>{node.name}/</summary><ul>{[...node.children.values()].map((child) => <FileTreeNode key={child.path} node={child} projectId={projectId} onChanged={onChanged} />)}</ul></details></li>;
  return <li><details className="project-file-row" onToggle={(event) => { if (event.currentTarget.open) setVisited(true); }}><summary>{node.name}</summary>{visited ? <ProjectFileViewer projectId={projectId} path={node.path} onChanged={onChanged} /> : null}</details></li>;
}
