import type { ToolRegistration } from '@earendil-works/pi-durable'
import { callTool } from './call'
import { askTool } from './control'
import { moreTool } from './more'
import { noteTool } from './note'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    callTool(deps),
    queryTool(deps),
    probeTool(deps),
    moreTool(deps),
    noteTool(deps),
    // Asking the user is the one tool that does not read storage.
    askTool(),
  ] as ToolRegistration[]
}
