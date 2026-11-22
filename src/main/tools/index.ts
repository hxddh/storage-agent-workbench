import type { ToolRegistration } from '@earendil-works/pi-durable'
import { callTool } from './call'
import { askTool } from './control'
import { delegateTool } from './delegate'
import { moreTool } from './more'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { workspaceTool } from './workspace'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const tools = [
    callTool(deps),
    queryTool(deps),
    probeTool(deps),
    moreTool(deps),
    workspaceTool(deps),
    delegateTool(deps),
    // Asking the user is the one tool that does not read storage.
    askTool(),
  ] as ToolRegistration[]
  deps.catalog = tools.map((tool) => ({ name: tool.name, description: tool.description }))
  return tools
}
