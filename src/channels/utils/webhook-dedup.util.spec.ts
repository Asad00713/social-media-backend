import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  dedupById,
  telegramUpdateDedup,
  WEBHOOK_DEDUP_TTL_MS,
  whatsappDeliveryDedup,
} from './webhook-dedup.util';

/**
 * A replayed webhook delivery must not be processed twice.
 *
 * Signature verification is sound on every route here, but a signature is
 * computed over the body alone — it says nothing about freshness, so a
 * delivery captured once stays valid and can be resent.
 *
 * Most of what that could cause was already impossible (inbox upserts on
 * `(channelId, platformItemId)`, leadgen's `onConflictDoNothing`, Slack's
 * `jobId: event_id`). The Maestro bridge was the gap, and the worst one to
 * have: it runs an AI agent and sends a reply, so a replay costs tokens and
 * messages the person twice, with no row downstream to conflict on.
 */

const controller = readFileSync(
  join(__dirname, '..', 'webhooks.controller.ts'),
  'utf8',
);

describe('the dedup option', () => {
  it('carries the id and the TTL BullMQ needs', () => {
    expect(dedupById('abc')).toEqual({
      deduplication: { id: 'abc', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  /**
   * The window has to cover a legitimate platform retry, or dedup would
   * defeat the delivery guarantee it is riding on: Telegram retries an update
   * for about a day, Meta for several hours.
   */
  it('remembers a delivery for 24h, past any platform retry', () => {
    expect(WEBHOOK_DEDUP_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('returns no dedup for %s', (_label, id) => {
    // Deliberately NOT a body hash: two distinct events that serialise
    // identically would collapse into one and a real message would be lost.
    // An unrecognised payload keeps today's behaviour instead.
    expect(dedupById(id)).toEqual({});
  });

  it('accepts a numeric id', () => {
    expect(dedupById(42)).toEqual({
      deduplication: { id: '42', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  it('spreads into an options bag without disturbing it', () => {
    const opts = { removeOnComplete: true, attempts: 2, ...dedupById('x') };
    expect(opts).toEqual({
      removeOnComplete: true,
      attempts: 2,
      deduplication: { id: 'x', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  it('spreads to nothing when there is no id, leaving the bag intact', () => {
    const opts = { removeOnComplete: true, ...dedupById(undefined) };
    expect(opts).toEqual({ removeOnComplete: true });
  });
});

describe('Telegram: update_id', () => {
  /**
   * Telegram documents `update_id` as unique per update and resends the same
   * one until the webhook answers 2xx — precisely the key this needs. It was
   * being discarded: `grep -rn "update_id" src` found no uses at all.
   */
  it('uses the update id, namespaced', () => {
    expect(telegramUpdateDedup({ update_id: 7788 })).toEqual({
      deduplication: { id: 'tg-7788', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  it('namespaces so a Telegram id cannot collide with a WhatsApp one', () => {
    const tg = telegramUpdateDedup({ update_id: 1 }) as {
      deduplication: { id: string };
    };
    const wa = whatsappDeliveryDedup(['1']) as {
      deduplication: { id: string };
    };
    expect(tg.deduplication.id).not.toBe(wa.deduplication.id);
  });

  it.each([
    ['an update with no id', { message: { text: 'hi' } }],
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('returns no dedup for %s', (_label, update) => {
    expect(telegramUpdateDedup(update)).toEqual({});
  });

  it('treats update_id 0 as a real id', () => {
    // `0` is falsy; a truthiness check here would drop a valid update's key.
    expect(telegramUpdateDedup({ update_id: 0 })).toEqual({
      deduplication: { id: 'tg-0', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });
});

describe('WhatsApp: the message id', () => {
  it('uses the first message id in the delivery', () => {
    expect(whatsappDeliveryDedup(['wamid.AAA', 'wamid.BBB'])).toEqual({
      deduplication: { id: 'wa-wamid.AAA', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  it('skips blank ids to find a real one', () => {
    expect(whatsappDeliveryDedup(['', '  ', 'wamid.CCC'])).toEqual({
      deduplication: { id: 'wa-wamid.CCC', ttl: WEBHOOK_DEDUP_TTL_MS },
    });
  });

  it.each([
    ['no messages', []],
    ['only blanks', ['', '   ']],
  ])('returns no dedup for %s', (_label, ids) => {
    // A status-only delivery; those are handled before the enqueue anyway.
    expect(whatsappDeliveryDedup(ids)).toEqual({});
  });

  it('is stable for the same delivery', () => {
    expect(whatsappDeliveryDedup(['wamid.X'])).toEqual(
      whatsappDeliveryDedup(['wamid.X']),
    );
  });
});

/**
 * A fail-closed net over the controller, because the gap this fixes was not a
 * wrong line — it was a MISSING one, and nothing would have failed if the
 * next webhook route forgot it too. The same shape that let two publishing
 * engines leak in BE #247 while a hand-written spec passed 14/14.
 */
describe('every webhook enqueue carries a replay key', () => {
  /** Each `<queue>.add(` call in the controller, with its options bag. */
  function enqueues(): Array<{ queue: string; call: string }> {
    const out: Array<{ queue: string; call: string }> = [];
    const re = /this\.(\w*[Qq]ueue)\.add\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(controller)) !== null) {
      // From the call to its matching `)`, by counting parens. A fixed
      // terminator was wrong: these calls sit at different indentation (the
      // leadgen one is nested two loops deep), so it cut that slice short of
      // the options bag and reported a deduplicated call as undeduplicated.
      const start = m.index;
      let depth = 0;
      let end = start;
      for (let i = controller.indexOf('(', start); i < controller.length; i++) {
        const ch = controller[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      out.push({ queue: m[1], call: controller.slice(start, end) });
    }
    return out;
  }

  const found = enqueues();

  it('finds the enqueues it is meant to police', () => {
    // Pinned so a route added without an enqueue, or one renamed, shows up
    // here rather than silently shrinking the net.
    expect(found.length).toBeGreaterThanOrEqual(6);
  });

  it.each(
    enqueues().map((e, i) => [i, e.queue, e.call] as [number, string, string]),
  )('enqueue %i (%s) is deduplicated', (_i, _queue, call) => {
    // Either BullMQ's TTL'd `deduplication` (directly, or through one of this
    // module's helpers — whose names differ in case: `dedupById`,
    // `telegramUpdateDedup`), or an explicit `jobId`, which is what the Slack
    // route uses and is sound there because that queue keeps completed jobs.
    const deduped = /deduplication|[Dd]edup\w*\(|jobId:/.test(call);
    expect({ deduped, call: call.slice(0, 120) }).toEqual({
      deduped: true,
      call: call.slice(0, 120),
    });
  });

  it('every Maestro bridge enqueue uses a TTL key, not a jobId', () => {
    // `removeOnComplete: true` frees a jobId, which is precisely the window a
    // replay uses — so these cannot rely on it.
    //
    // THREE, not two: besides the shared WhatsApp route and the Maestro
    // Telegram route, the dedicated Maestro WhatsApp number has a route of
    // its own. The first pass at this change wired two and missed the third;
    // this net is what found it, which is the reason it is written
    // fail-closed rather than as a list.
    const bridge = found.filter((e) => /maestroBridgeQueue/.test(e.queue));
    expect(bridge.length).toBe(3);
    for (const e of bridge) {
      expect(e.call).toMatch(/[Dd]edup\w*\(|deduplication/);
    }
  });
});
