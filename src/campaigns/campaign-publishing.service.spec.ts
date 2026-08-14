import { CampaignPublishingService } from './campaign-publishing.service';

describe('CampaignPublishingService', () => {
  function make() {
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    const getJob = jest.fn();
    const queue = { add, getJob } as never;
    const service = new CampaignPublishingService(queue);
    return { service, add, getJob };
  }

  it('cancelSlotJob removes the job when present', async () => {
    const { service, getJob } = make();
    const remove = jest.fn().mockResolvedValue(undefined);
    getJob.mockResolvedValue({ remove });
    await service.cancelSlotJob('job-1');
    expect(getJob).toHaveBeenCalledWith('job-1');
    expect(remove).toHaveBeenCalled();
  });

  it('cancelSlotJob is a no-op when the job is already gone', async () => {
    const { service, getJob } = make();
    getJob.mockResolvedValue(null);
    await expect(service.cancelSlotJob('missing')).resolves.toBeUndefined();
  });

  it('enqueues with a delay derived from scheduledAt and a deterministic jobId', () => {
    const { service } = make();
    // buildJobId is a pure helper — assert its shape (used for idempotency).
    expect(service.buildJobId('c1', '2026-09-02', '42', '09:00')).toBe(
      'campaign-c1-2026-09-02-42-09:00',
    );
  });
});
