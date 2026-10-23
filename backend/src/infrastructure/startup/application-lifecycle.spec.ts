import { startApplicationMaintenance } from '@/infrastructure/startup/application-lifecycle';

describe('application maintenance', () => {
  it('starts cleanup and scheduling in the normal application process', async () => {
    const starters = { startApiMaintenance: jest.fn().mockResolvedValue(undefined), startAutomationWorker: jest.fn().mockResolvedValue(undefined) };
    await startApplicationMaintenance(starters);
    expect(starters.startApiMaintenance).toHaveBeenCalledTimes(1);
    expect(starters.startAutomationWorker).toHaveBeenCalledTimes(1);
  });
});
