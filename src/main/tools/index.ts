import type { ToolRegistration } from '@earendil-works/pi-durable'
import { bucketTools } from './browse'
import { configTool } from './config'
import { planTool, playbookTool, reportTool } from './control'
import { estateTools } from './estate'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { surveyTool } from './survey'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    // Control tools. They do not read storage; they let the agent publish its
    // plan, consult the field guide and compose an evidence-backed answer.
    planTool(),
    playbookTool(),
    reportTool(),
    surveyTool(deps),
    ...bucketTools(deps),
    configTool(deps),
    probeTool(deps),
    ...estateTools(deps),
    queryTool(deps),
  ] as ToolRegistration[]
}
