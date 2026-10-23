import type { AgentApi } from '@shared/contract'

declare global {
  interface Window {
    agent: AgentApi
  }
}
