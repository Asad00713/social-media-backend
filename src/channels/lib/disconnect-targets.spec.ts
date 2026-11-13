import { planDisconnect } from './disconnect-targets';

const t = (channelId: string, status: string, extra: object = {}) => ({
  channelId,
  platform: 'mastodon',
  status,
  ...extra,
});

describe('planDisconnect', () => {
  it('deletes a post that only ever targeted this channel', () => {
    expect(planDisconnect('scheduled', [t('98', 'scheduled')], '98')).toEqual({
      kind: 'delete',
    });
    expect(planDisconnect('draft', [t('98', 'draft')], '98').kind).toBe(
      'delete',
    );
    expect(planDisconnect('failed', [t('98', 'failed')], '98').kind).toBe(
      'delete',
    );
  });

  it('takes this channel out of a shared post and leaves the others going', () => {
    const plan = planDisconnect(
      'scheduled',
      [t('9', 'scheduled'), t('98', 'scheduled'), t('101', 'scheduled')],
      '98',
    );
    expect(plan).toEqual({
      kind: 'detach',
      targets: [t('9', 'scheduled'), t('101', 'scheduled')],
      status: 'scheduled',
    });
  });

  it('matches a numeric channel id written by an older client', () => {
    const plan = planDisconnect(
      'scheduled',
      [{ channelId: 98, status: 'scheduled' }],
      '98',
    );
    expect(plan.kind).toBe('delete');
  });

  it('keeps what already went out, and the post with it', () => {
    expect(planDisconnect('published', [t('98', 'published')], '98').kind).toBe(
      'keep',
    );
    // Published per the composer's own field only.
    expect(
      planDisconnect(
        'published',
        [{ channelId: '98', status: 'scheduled', publishStatus: 'published' }],
        '98',
      ).kind,
    ).toBe('keep');
    // A platform post id means it is live, whatever the status says.
    expect(
      planDisconnect(
        'failed',
        [t('98', 'failed', { platformPostId: 'abc' })],
        '98',
      ).kind,
    ).toBe('keep');
  });

  it('a partly published post whose failed part was this channel is now published', () => {
    const plan = planDisconnect(
      'partially_published',
      [t('9', 'published'), t('98', 'failed')],
      '98',
    );
    expect(plan).toEqual({
      kind: 'detach',
      targets: [t('9', 'published')],
      status: 'published',
    });
  });

  it('a failed post stays failed while another channel failed too', () => {
    const plan = planDisconnect(
      'failed',
      [t('9', 'failed'), t('98', 'failed')],
      '98',
    );
    expect(plan).toMatchObject({ kind: 'detach', status: 'failed' });
  });

  it('removes a target the pause was holding', () => {
    const plan = planDisconnect(
      'scheduled',
      [t('98', 'scheduled', { heldAt: '2026-11-13T10:00:00Z' })],
      '98',
    );
    expect(plan.kind).toBe('delete');
  });

  it('leaves a post alone while it is being published', () => {
    expect(
      planDisconnect('publishing', [t('98', 'scheduled')], '98').kind,
    ).toBe('keep');
  });

  it('does nothing to a post that does not target the channel', () => {
    expect(planDisconnect('scheduled', [t('9', 'scheduled')], '98').kind).toBe(
      'keep',
    );
  });
});
