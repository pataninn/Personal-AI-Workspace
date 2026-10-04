import { useEffect, useState } from 'react';

/** Preview PDFs and common image files through local object URLs. */
export function BinaryFilePreview({ blob, path }: { readonly blob: Blob; readonly path: string }): React.JSX.Element {
  const [url, setUrl] = useState('');
  const suffix = path.split('.').at(-1)?.toLowerCase();
  const type = suffix === 'pdf' ? 'application/pdf' : suffix === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(suffix ?? '') ? 'image/jpeg' : suffix === 'webp' ? 'image/webp' : null;
  useEffect(() => {
    if (!type) return;
    const objectUrl = URL.createObjectURL(new Blob([blob], { type }));
    setUrl(objectUrl);
    return () => { URL.revokeObjectURL(objectUrl); };
  }, [blob, type]);
  if (!url || !type) return <p>Download this file to view it in its associated app.</p>;
  return type === 'application/pdf' ? <iframe className="file-binary-preview" src={url} title={`Preview of ${path}`} /> : <img src={url} alt={`Preview of ${path}`} className="file-binary-preview" />;
}
