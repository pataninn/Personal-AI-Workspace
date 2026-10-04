interface ProviderTermsProps {
  readonly providerProfile: string;
}

/** Shows the terms for the service receiving the selected context. */
export function ProviderTerms({ providerProfile }: ProviderTermsProps): React.JSX.Element {
  if (providerProfile === 'nebius-token-factory') {
    return <>
      <p>Nebius Token Factory receives the selected context to generate a response. Its terms allow storage and use of inputs and outputs for speculative decoding, with an opt-out available through onboarding or support. Review your account settings and only send content you are authorized to share.</p>
      <a href="https://docs.tokenfactory.nebius.com/legal/terms-of-service" target="_blank" rel="noreferrer">Read Nebius Token Factory Terms</a>
    </>;
  }
  return <>
    <p>NVIDIA API Catalog trial terms require you to have rights to submit content, prohibit confidential or sensitive data, and allow submitted content to be reviewed and used to improve services. Other NVIDIA subscriptions may have different terms.</p>
    <a href="https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf" target="_blank" rel="noreferrer">Read NVIDIA API Trial Terms</a>
  </>;
}
