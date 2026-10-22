import { NEBIUS_PROVIDER_PROFILE } from '@/modules/ai-runs/domain/model-provider-profile';

// Nebius lists a 256K-token context; serialized request bytes are not a token bound: https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference
export const HOME_NEBIUS_NEMOTRON_BOUND = {
  providerProfile: NEBIUS_PROVIDER_PROFILE,
  model: 'nvidia/nemotron-3-super-120b-a12b',
  maxInputTokens: 262_144,
  maxOutputTokens: 512,
  version: 'nebius-nemotron-context-v1'
} as const;
