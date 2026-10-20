export type ApplicationLifecycleMode = 'api' | 'automation-worker';

export interface ApplicationMaintenanceStarters {
  startApiMaintenance(): Promise<void>;
  startAutomationWorker(): Promise<void>;
}

export async function startApplicationMaintenance(
  mode: ApplicationLifecycleMode,
  starters: ApplicationMaintenanceStarters
): Promise<void> {
  if (mode === 'api') {
    await starters.startApiMaintenance();
    return;
  }
  await starters.startAutomationWorker();
}
