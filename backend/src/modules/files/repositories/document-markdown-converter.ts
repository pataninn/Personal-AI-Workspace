export interface IDocumentMarkdownConverter {
  convert(input: { readonly fileName: string; readonly bytes: Buffer }): Promise<Buffer>;
}
