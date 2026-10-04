export const NVIDIA_PROVIDER_PROFILE = 'nvidia-hosted-nim';
export const NEBIUS_PROVIDER_PROFILE = 'nebius-token-factory';

/** Identifies the service receiving context, independently of the model publisher. */
export function providerLabel(profile: string): 'NVIDIA hosted NIM' | 'Nebius Token Factory' {
  return profile === NEBIUS_PROVIDER_PROFILE ? 'Nebius Token Factory' : 'NVIDIA hosted NIM';
}
