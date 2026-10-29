export function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
}

export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

export function transferFolders(value: unknown): { projectFolder: string; dailyFolder: string } {
  const config = value && typeof value === 'object' && 'config' in value ? value.config : null;
  return {
    projectFolder: config && typeof config === 'object' && 'projectFolder' in config && typeof config.projectFolder === 'string' ? config.projectFolder : '',
    dailyFolder: config && typeof config === 'object' && 'dailyFolder' in config && typeof config.dailyFolder === 'string' ? config.dailyFolder : '',
  };
}
