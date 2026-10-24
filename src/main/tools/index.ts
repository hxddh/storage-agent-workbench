import type { ToolRegistration } from '@earendil-works/pi-durable'
import { bucketTools } from './browse'
import { configTool } from './config'
import { estateTools } from './estate'
import type { ToolDeps } from './policy'
import { probeTool } from './probe'
import { queryTool } from './query'
import { surveyTool } from './survey'

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [
    surveyTool(deps),
    ...bucketTools(deps),
    configTool(deps),
    probeTool(deps),
    ...estateTools(deps),
    queryTool(deps),
  ] as ToolRegistration[]
}
