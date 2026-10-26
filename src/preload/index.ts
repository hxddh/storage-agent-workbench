import type { AgentApi, AppCommand, AppEvent } from '@shared/contract'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api: AgentApi = {
  bootstrap: () => ipcRenderer.invoke('agent:bootstrap'),
  openTask: (id, focus) => ipcRenderer.invoke('agent:openTask', id, focus),
  older: (taskId, before) => ipcRenderer.invoke('agent:older', taskId, before),
  createTask: (text, attachments, context) =>
    ipcRenderer.invoke('agent:createTask', text, attachments, context),
  audit: () => ipcRenderer.invoke('agent:audit'),
  send: (taskId, text, attachments, context) =>
    ipcRenderer.invoke('agent:send', taskId, text, attachments, context),
  estateRefs: (query) => ipcRenderer.invoke('agent:estateRefs', query),
  steer: (taskId, text) => ipcRenderer.invoke('agent:steer', taskId, text),
  stop: (taskId) => ipcRenderer.invoke('agent:stop', taskId),
  renameTask: (taskId, title) => ipcRenderer.invoke('agent:renameTask', taskId, title),
  pinTask: (taskId, pinned) => ipcRenderer.invoke('agent:pinTask', taskId, pinned),
  deleteTask: (taskId) => ipcRenderer.invoke('agent:deleteTask', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('agent:retryTask', taskId),
  continueTask: (taskId) => ipcRenderer.invoke('agent:continueTask', taskId),
  reverifyTask: (taskId) => ipcRenderer.invoke('agent:reverifyTask', taskId),
  search: (query) => ipcRenderer.invoke('agent:search', query),
  notes: () => ipcRenderer.invoke('agent:notes'),
  deleteNote: (id) => ipcRenderer.invoke('agent:deleteNote', id),
  saveText: (input) => ipcRenderer.invoke('agent:saveText', input),
  exportPdf: () => ipcRenderer.invoke('agent:exportPdf'),
  pickFiles: () => ipcRenderer.invoke('agent:pickFiles'),
  // Only a real dropped or pasted file has a path; a File the page constructs has none.
  stageFiles: (files) =>
    ipcRenderer.invoke(
      'agent:stagePaths',
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  acceptIssue: (id, accepted) => ipcRenderer.invoke('agent:acceptIssue', id, accepted),
  awsProfiles: () => ipcRenderer.invoke('agent:awsProfiles'),
  installUpdate: () => ipcRenderer.invoke('agent:installUpdate'),
  addDemoAccount: () => ipcRenderer.invoke('agent:addDemoAccount'),
  localModels: () => ipcRenderer.invoke('agent:localModels'),
  saveAccount: (input) => ipcRenderer.invoke('agent:saveAccount', input),
  deleteAccount: (id) => ipcRenderer.invoke('agent:deleteAccount', id),
  testAccount: (id) => ipcRenderer.invoke('agent:testAccount', id),
  saveModel: (input) => ipcRenderer.invoke('agent:saveModel', input),
  listModels: (input) => ipcRenderer.invoke('agent:listModels', input),
  clearModel: () => ipcRenderer.invoke('agent:clearModel'),
  testModel: (input) => ipcRenderer.invoke('agent:testModel', input),
  saveSettings: (patch) => ipcRenderer.invoke('agent:saveSettings', patch),
  openExternal: (url) => ipcRenderer.invoke('agent:openExternal', url),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand) => listener(command)
    ipcRenderer.on('agent:command', handler)
    return () => ipcRenderer.removeListener('agent:command', handler)
  },
}

contextBridge.exposeInMainWorld('agent', api)
