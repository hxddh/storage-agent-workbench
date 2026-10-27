import type { ToolRegistration } from '@earendil-works/pi-durable'
import { bucketTools } from './browse'
import { configTool } from './config'
import { planTool, skillTool } from './control'
import { estateTools } from './estate'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { surveyTool } from './survey'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    // Control tools. They do not read storage; they publish the optional plan
    // or return a method card.
    planTool(),
    skillTool(),
    surveyTool(deps),
    ...bucketTools(deps),
    configTool(deps),
    probeTool(deps),
    ...estateTools(deps),
    queryTool(deps),
  ] as ToolRegistration[]
}
