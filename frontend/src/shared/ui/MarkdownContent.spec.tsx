import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/shared/ui/MarkdownContent';

describe('Markdown content', () => {
  it('renders tables, lists, code and math without executing raw HTML or unsafe links', () => {
    const { container } = render(<MarkdownContent content={'# Answer\n\n| A | B |\n|---|---|\n| one | two |\n\n- first\n- second\n\n```js\nconst value = 1;\n```\n\n$x^2$\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)'} />);
    expect(screen.getByRole('heading', { name: 'Answer' })).toBeVisible();
    expect(screen.getByRole('table')).toBeVisible();
    expect(container.querySelector('pre code')).toHaveTextContent('const value = 1;');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByRole('link', { name: 'good' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('copies code and reports success', async () => {
    const user = userEvent.setup();
    render(<MarkdownContent content={'```text\ncopy me\n```'} />);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toBe('copy me\n');
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('blocks remote and backslash-normalized images while allowing local paths', () => {
    const { container } = render(<MarkdownContent content={'![remote](https://example.com/a.png)\n\n![protocol](//example.com/a.png)\n\n![backslash](/%5Cexample.com/a.png)\n\n![local](/images/local.png)'} />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute('src', '/images/local.png');
    expect(screen.getByText('[Image: remote]')).toBeInTheDocument();
  });
});
