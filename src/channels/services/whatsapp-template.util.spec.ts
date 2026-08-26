import {
  parseWhatsAppTemplateEvents,
  mapMetaTemplateRow,
} from './whatsapp-template.util';
import { parseWhatsAppMessages } from './whatsapp-webhook.util';

const statusPayload = (event: string, reason: string | null = 'NONE') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      time: 1751247548,
      changes: [
        {
          field: 'message_template_status_update',
          value: {
            event,
            message_template_id: 1689556908129832,
            message_template_name: 'order_confirmation',
            message_template_language: 'en-US',
            reason,
            message_template_category: 'UTILITY',
          },
        },
      ],
    },
  ],
});

describe('parseWhatsAppTemplateEvents', () => {
  it('parses an APPROVED event', () => {
    const [ev] = parseWhatsAppTemplateEvents(statusPayload('APPROVED'));
    expect(ev).toEqual({
      wabaId: '102290129340398',
      metaTemplateId: '1689556908129832',
      name: 'order_confirmation',
      language: 'en-US',
      status: 'APPROVED',
      category: 'UTILITY',
      reason: 'NONE',
    });
  });

  it.each([
    'APPROVED',
    'PENDING',
    'REJECTED',
    'PAUSED',
    'DISABLED',
    'FLAGGED',
    'ARCHIVED',
    'UNARCHIVED',
    'DELETED',
    'IN_APPEAL',
    'LIMIT_EXCEEDED',
    'LOCKED',
    'REINSTATED',
    'PENDING_DELETION',
  ])('parses the %s event', (event) => {
    const [ev] = parseWhatsAppTemplateEvents(statusPayload(event));
    expect(ev.status).toBe(event);
  });

  it('carries the rejection reason through', () => {
    const [ev] = parseWhatsAppTemplateEvents(
      statusPayload('REJECTED', 'INCORRECT_CATEGORY'),
    );
    expect(ev.reason).toBe('INCORRECT_CATEGORY');
  });

  it('tolerates a null reason', () => {
    const [ev] = parseWhatsAppTemplateEvents(
      statusPayload('PENDING_DELETION', null),
    );
    expect(ev.reason).toBeNull();
  });

  it('ignores message events', () => {
    const messagePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            { field: 'messages', value: { messages: [{ id: 'wamid.X' }] } },
          ],
        },
      ],
    };
    expect(parseWhatsAppTemplateEvents(messagePayload)).toEqual([]);
  });

  it.each([
    [null],
    [undefined],
    [{}],
    [{ object: 'page' }],
    [{ object: 'whatsapp_business_account' }],
    [{ object: 'whatsapp_business_account', entry: [{}] }],
    [{ object: 'whatsapp_business_account', entry: [{ changes: [{}] }] }],
  ])('returns [] for malformed payload %#', (payload) => {
    expect(parseWhatsAppTemplateEvents(payload as any)).toEqual([]);
  });

  it('leaves parseWhatsAppMessages untouched for message payloads', () => {
    // Regression guard: the two parsers must not interfere. Inbox ingest and
    // the Maestro bridge both depend on parseWhatsAppMessages.
    const messagePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1010' },
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.HBgL',
                    timestamp: '1719400000',
                    type: 'text',
                    text: { body: 'Hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsAppMessages(messagePayload)).toHaveLength(1);
    expect(parseWhatsAppTemplateEvents(messagePayload)).toEqual([]);
  });
});

describe('mapMetaTemplateRow', () => {
  it('maps a Meta list row', () => {
    const row = {
      id: '1689556908129832',
      name: 'order_confirmation',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Your order {{1}} shipped.' }],
    };
    expect(mapMetaTemplateRow(row)).toEqual({
      metaTemplateId: '1689556908129832',
      name: 'order_confirmation',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Your order {{1}} shipped.' }],
    });
  });

  it('defaults components to [] when Meta omits them', () => {
    const row = {
      id: '1',
      name: 'n',
      language: 'en',
      category: 'MARKETING',
      status: 'PENDING',
    };
    expect(mapMetaTemplateRow(row).components).toEqual([]);
  });
});
