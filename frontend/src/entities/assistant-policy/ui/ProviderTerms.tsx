interface ProviderTermsProps {
  readonly providerName: string;
}

const TERMS_DESTINATIONS: Readonly<Record<string, { readonly href: string; readonly label: string; readonly description?: string }>> = {
  'Nebius Token Factory': {
    href: 'https://docs.nebius.com/legal/token-factory',
    label: 'Read Nebius Token Factory terms'
  },
  'NVIDIA hosted NIM': {
    href: 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
    label: 'Read NVIDIA API Trial Terms',
    description: 'NVIDIA API Catalog trial terms prohibit confidential or sensitive data. Other NVIDIA subscriptions may have different terms.'
  }
};

/** Links only to verified terms for providers the server names explicitly. */
export function ProviderTerms({ providerName }: ProviderTermsProps): React.JSX.Element | null {
  const destination = Object.entries(TERMS_DESTINATIONS).find(([name]) => name === providerName)?.[1];
  if (!destination) return null;

  return <>
    {destination.description ? <p className="m-0 text-[var(--color-text-muted)]">{destination.description}</p> : null}
    <a
      className="inline-block rounded-sm text-[var(--color-text)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      href={destination.href}
      target="_blank"
      rel="noopener noreferrer"
    >{destination.label}</a>
  </>;
}
