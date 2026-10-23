import type { AgentApi, AppEvent } from '@shared/contract'
import { contextBridge, ipcRenderer } from 'electron'

const api: AgentApi = {
  bootstrap: () => ipcRenderer.invoke('agent:bootstrap'),
  openTask: (id) => ipcRenderer.invoke('agent:openTask', id),
  older: (taskId, before) => ipcRenderer.invoke('agent:older', taskId, before),
  createTask: (text, attachments) => ipcRenderer.invoke('agent:createTask', text, attachments),
  send: (taskId, text, attachments) => ipcRenderer.invoke('agent:send', taskId, text, attachments),
  steer: (taskId, text) => ipcRenderer.invoke('agent:steer', taskId, text),
  stop: (taskId) => ipcRenderer.invoke('agent:stop', taskId),
  renameTask: (taskId, title) => ipcRenderer.invoke('agent:renameTask', taskId, title),
  deleteTask: (taskId) => ipcRenderer.invoke('agent:deleteTask', taskId),
  pickFiles: () => ipcRenderer.invoke('agent:pickFiles'),
  saveAccount: (input) => ipcRenderer.invoke('agent:saveAccount', input),
  deleteAccount: (id) => ipcRenderer.invoke('agent:deleteAccount', id),
  testAccount: (id) => ipcRenderer.invoke('agent:testAccount', id),
  saveModel: (input) => ipcRenderer.invoke('agent:saveModel', input),
  clearModel: () => ipcRenderer.invoke('agent:clearModel'),
  testModel: () => ipcRenderer.invoke('agent:testModel'),
  saveSettings: (patch) => ipcRenderer.invoke('agent:saveSettings', patch),
  setWatch: (providerId, patch) => ipcRenderer.invoke('agent:setWatch', providerId, patch),
  runWatch: (providerId) => ipcRenderer.invoke('agent:runWatch', providerId),
  openExternal: (url) => ipcRenderer.invoke('agent:openExternal', url),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  onCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: 'settings' | 'new-task') =>
      listener(command)
    ipcRenderer.on('agent:command', handler)
    return () => ipcRenderer.removeListener('agent:command', handler)
  },
}

contextBridge.exposeInMainWorld('agent', api)
