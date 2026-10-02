import { ErrorCodes, parse, type DefaultTreeAdapterMap } from 'parse5';

import { ChangeSetValidationError } from '@/modules/ai-runs/domain/change-errors';

type HtmlDocument = DefaultTreeAdapterMap['document'];
type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlParent = DefaultTreeAdapterMap['parentNode'];

const INCOMPLETE_HTML_ERRORS = new Set([
  ErrorCodes.eofBeforeTagName,
  ErrorCodes.eofInTag,
  ErrorCodes.eofInComment,
  ErrorCodes.eofInDoctype,
  ErrorCodes.eofInCdata,
  ErrorCodes.eofInScriptHtmlCommentLikeText,
  ErrorCodes.eofInElementThatCanContainOnlyText
]);

export interface HtmlDocumentChange {
  readonly path: string;
  readonly sourceContent: string | undefined;
  readonly content: string | undefined;
}

/** Rejects truncated HTML and loss of existing document boundaries before collection. */
export function validateHtmlDocumentChange(input: HtmlDocumentChange): void {
  if (!/\.html?$/iu.test(input.path) || input.content === undefined) return;
  let incomplete = false;
  const proposed = parse(input.content, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => { incomplete ||= INCOMPLETE_HTML_ERRORS.has(error.code); }
  });
  const source = parse(input.sourceContent ?? '', { sourceCodeLocationInfo: true });
  if (incomplete || losesDocumentStructure(source, proposed)) {
    throw new ChangeSetValidationError([{ field: 'content', message: 'The proposed HTML document is incomplete.' }]);
  }
}

function losesDocumentStructure(source: HtmlDocument, proposed: HtmlDocument): boolean {
  const originalRoot = childElement(source, 'html');
  const proposedRoot = childElement(proposed, 'html');
  return ['html', 'head', 'body'].some((tag) => {
    const original = tag === 'html' ? originalRoot : originalRoot && childElement(originalRoot, tag);
    const replacement = tag === 'html' ? proposedRoot : proposedRoot && childElement(proposedRoot, tag);
    return losesExplicitBoundary(original, replacement);
  });
}

function losesExplicitBoundary(original?: HtmlElement, replacement?: HtmlElement): boolean {
  const before = original?.sourceCodeLocation;
  const after = replacement?.sourceCodeLocation;
  return Boolean((before?.startTag && !after?.startTag) || (before?.endTag && !after?.endTag));
}

function childElement(parent: HtmlParent, tagName: string): HtmlElement | undefined {
  return parent.childNodes.find((node): node is HtmlElement => 'tagName' in node && node.tagName === tagName);
}
