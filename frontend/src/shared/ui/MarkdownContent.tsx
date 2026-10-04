import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { MarkdownCodeBlock } from '@/shared/ui/MarkdownCodeBlock';

interface MarkdownContentProps {
  readonly content: string;
}

/** Use for stored and streaming Markdown; raw HTML is never executed. */
export function MarkdownContent({ content }: MarkdownContentProps): React.JSX.Element {
  return <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false }]]}
    components={{
      pre: MarkdownCodeBlock,
      a: ({ children, href }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ src, alt }) => src?.startsWith('/') && !src.startsWith('//') && !/\\|%5c/iu.test(src) ? <img src={src} alt={alt ?? ''} loading="lazy" /> : <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span>
    }}>{content}</Markdown></div>;
}
