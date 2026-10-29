import type { ToolRegistration } from '@earendil-works/pi-durable'
import { callTool } from './call'
import { askTool } from './control'
import { delegateTool } from './delegate'
import { discoverTool } from './discover'
import { memoryTool } from './memory'
import { moreTool } from './more'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { renderTool } from './render'
import { toolTool } from './tool'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    callTool(deps),
    queryTool(deps),
    probeTool(deps),
    moreTool(deps),
    discoverTool(deps),
    renderTool(deps),
    memoryTool(deps),
    toolTool(deps),
    delegateTool(deps),
    // Asking the user is the one tool that does not read storage.
    askTool(),
  ] as ToolRegistration[]
}
