export const PACKAGE = '@z1/provider'

export {
  DEFAULT_PROVIDERS,
  MOCK_PROVIDER,
  ProviderRegistry,
  providersFromEnv,
  resolveApiKey,
  resolveBaseUrl,
} from './registry.ts'
export type {
  ProviderConfig,
  ProviderEnv,
  ProviderProtocol,
  ProviderRegistryOptions,
} from './registry.ts'
