import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PortalLinkDto } from './portal-link.dto';

async function errorsFor(body: unknown) {
  return validate(plainToInstance(PortalLinkDto, body));
}

describe('PortalLinkDto', () => {
  it.each(['portal', 'update_payment_method'])('accepts %s', async (intent) => {
    expect(await errorsFor({ intent })).toHaveLength(0);
  });

  it.each([{}, { intent: 'cancel' }, { intent: '' }, { intent: 1 }])(
    'rejects %j',
    async (body) => {
      expect(await errorsFor(body)).not.toHaveLength(0);
    },
  );
});
