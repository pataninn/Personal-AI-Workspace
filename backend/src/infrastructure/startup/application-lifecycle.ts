export interface ApplicationMaintenanceStarters {
  startApiMaintenance(): Promise<void>;
  startAutomationWorker(): Promise<void>;
}

/** One process owns both scheduled execution and ordinary workspace maintenance. */
export async function startApplicationMaintenance(starters: ApplicationMaintenanceStarters): Promise<void> {
  await starters.startApiMaintenance();
  await starters.startAutomationWorker();
}
