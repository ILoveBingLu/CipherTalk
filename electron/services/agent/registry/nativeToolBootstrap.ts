import { createNativeSessionQATools, createNativeUtilityTools } from './adapters/nativeToolAdapter'
import { toolRegistry } from './toolRegistry'

let nativeToolsRegistered = false

export function registerNativeAgentTools(): void {
  if (nativeToolsRegistered) return
  nativeToolsRegistered = true

  for (const tool of createNativeUtilityTools()) {
    toolRegistry.upsert(tool)
  }

  for (const tool of createNativeSessionQATools()) {
    toolRegistry.upsert(tool)
  }
}
