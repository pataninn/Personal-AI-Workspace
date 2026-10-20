import { startApplicationMaintenance } from '@/infrastructure/startup/application-lifecycle';

describe('startApplicationMaintenance', () => {
  it('starts only API maintenance in API mode', async () => {
    const starters = {
      startApiMaintenance: jest.fn().mockResolvedValue(undefined),
      startAutomationWorker: jest.fn().mockResolvedValue(undefined)
    };

    await startApplicationMaintenance('api', starters);

    expect(starters.startApiMaintenance).toHaveBeenCalledTimes(1);
    expect(starters.startAutomationWorker).not.toHaveBeenCalled();
  });

  it('starts only the scheduler in automation-worker mode', async () => {
    const starters = {
      startApiMaintenance: jest.fn().mockResolvedValue(undefined),
      startAutomationWorker: jest.fn().mockResolvedValue(undefined)
    };

    await startApplicationMaintenance('automation-worker', starters);

    expect(starters.startAutomationWorker).toHaveBeenCalledTimes(1);
    expect(starters.startApiMaintenance).not.toHaveBeenCalled();
  });
});
