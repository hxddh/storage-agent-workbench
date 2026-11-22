import type { ToolRegistration } from '@earendil-works/pi-durable'
import { callTool } from './call'
import { askTool } from './control'
import { delegateTool } from './delegate'
import { moreTool } from './more'
import { notifyTool } from './notify'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { scheduleTool } from './schedule'
import { selfTool } from './self'
import { workspaceTool } from './workspace'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const tools = [
    callTool(deps),
    queryTool(deps),
    probeTool(deps),
    moreTool(deps),
    workspaceTool(deps),
    selfTool(deps),
    scheduleTool(deps),
    notifyTool(deps),
    delegateTool(deps),
    // Asking the user is the one tool that does not read storage.
    askTool(),
  ] as ToolRegistration[]
  deps.catalog = tools.map((tool) => ({ name: tool.name, description: tool.description }))
  return tools
}
