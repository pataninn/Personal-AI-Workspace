import { useEffect, useMemo, useState } from 'react';

import type { ShowcasePreviewFile } from '@/entities/showcase';

interface PreviewFileContentProps {
  readonly file: ShowcasePreviewFile;
}

export function PreviewFileContent({ file }: PreviewFileContentProps): React.JSX.Element {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const decoded = useMemo(() => decodeBase64(file.contentBase64), [file.contentBase64]);
  const textContent = decoded && isTextMediaType(file.mediaType) ? new TextDecoder().decode(decoded) : null;

  useEffect(() => {
    if (!decoded) return;
    const url = URL.createObjectURL(new Blob([copyBytes(decoded)], { type: 'application/octet-stream' }));
    setDownloadUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [decoded]);

  return (
    <div className="grid gap-3 border-t border-[var(--color-border)] pt-3">
      <p className="text-sm text-[var(--color-text-muted)]">{formatBytes(file.byteLength)} · {file.mediaType}</p>
      {textContent !== null ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-surface-muted)] p-3 text-sm">{textContent}</pre> : <p className="text-sm text-[var(--color-text-muted)]">Binary file. Download it to inspect the exact bytes included in the preview.</p>}
      {downloadUrl ? <a className="button button-secondary w-fit" href={downloadUrl} download={file.name.split('/').at(-1) ?? 'showcase-file'}>Download exact file bytes</a> : null}
      {!decoded ? <p className="text-sm text-[var(--color-error)]" role="alert">The selected file preview could not be decoded safely.</p> : null}
    </div>
  );
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function isTextMediaType(value: string): boolean {
  return value.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/javascript'].includes(value);
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatBytes(value: number): string {
  if (value < 1000) return `${value} bytes`;
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value / 1000;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}
