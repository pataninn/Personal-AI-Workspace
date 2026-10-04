import { useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import type { ExtraProps } from 'react-markdown';
import { Button } from '@/shared/ui/Button';

/** Render a fenced code block with an accessible clipboard action. */
export function MarkdownCodeBlock({ children, node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps): React.JSX.Element {
  const [notice, setNotice] = useState('');
  const code = node?.children[0];
  const text = code?.type === 'element' ? code.children.map((child) => child.type === 'text' ? child.value : '').join('') : '';
  const classes = code?.type === 'element' ? code.properties.className : null;
  const language = Array.isArray(classes) ? classes.find((value) => typeof value === 'string' && value.startsWith('language-'))?.toString().replace('language-', '') : '';

  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(text); setNotice('Copied'); }
    catch { setNotice('Copy failed. Select the code to copy it.'); }
  }

  return <div className="markdown-code-block"><div className="markdown-code-header"><span>{language || 'Code'}</span><Button type="button" variant="ghost" data-testid="markdown-code-copy" aria-label="Copy code" onClick={() => { void copy(); }}>Copy</Button><span className="supporting-copy" role="status">{notice}</span></div><pre {...props}>{children}</pre></div>;
}
