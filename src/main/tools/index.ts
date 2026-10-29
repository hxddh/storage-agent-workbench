import type { ToolRegistration } from '@earendil-works/pi-durable'
import { accountTool } from './account'
import { bucketTools } from './browse'
import { configTool } from './config'
import { askTool } from './control'
import { noteTool } from './note'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    ...bucketTools(deps),
    configTool(deps),
    accountTool(deps),
    probeTool(deps),
    queryTool(deps),
    noteTool(deps),
    // Asking the user is the one tool that does not read storage.
    askTool(),
  ] as ToolRegistration[]
}
