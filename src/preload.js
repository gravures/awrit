import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('ipc', {
  // Navigation functions
  navigateBack: () => ipcRenderer.send('toolbar:navigate-back'),
  navigateForward: () => ipcRenderer.send('toolbar:navigate-forward'),
  refresh: () => ipcRenderer.send('toolbar:navigate-refresh'),
  navigateTo: (url) => ipcRenderer.send('toolbar:navigate-to', url),

  // Find in page functions
  findInPage: (text, options) => ipcRenderer.invoke('findInPage', text, options),
  stopFindInPage: () => ipcRenderer.invoke('stopFindInPage'),

  // Toolbar focus/blur (07-02)
  onFocusUrl: (callback) => ipcRenderer.on('toolbar:focus-url', callback),
  onBlurUrl: (callback) => ipcRenderer.on('toolbar:blur-url', callback),
  onSearchEngineChanged: (callback) => ipcRenderer.on('toolbar:search-engine-changed', (_event, engine) => callback(engine)),
  getSearchEngine: () => ipcRenderer.invoke('toolbar:get-search-engine'),

  // Event listeners
  onLoadingStarted: (callback) => ipcRenderer.on('content:loading-started', callback),
  onLoadingStopped: (callback) => ipcRenderer.on('content:loading-stopped', callback),
  onUrlChanged: (callback) => ipcRenderer.on('content:url-changed', (_event, url) => callback(url)),
  onNavigationStateChanged: (callback) =>
    ipcRenderer.on('content:navigation-state-changed', (_event, state) => callback(state)),
  onToggleFind: (callback) => ipcRenderer.on('toolbar:toggle-find', callback),
});
