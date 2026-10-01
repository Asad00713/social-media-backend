import { z } from 'zod';
import type { AgentToolDefinition } from '../maestro.types';

/**
 * The places the agent may send the user.
 *
 * Names, never URLs. The backend does not own frontend routing — the client
 * holds the route table and turns a name into a path, exactly as it already
 * does for entity references. A model that writes its own links writes broken
 * ones, and a path list in a prompt goes stale the first time a route moves.
 *
 * This list must stay in step with `destinations.ts` on the frontend. A name
 * that file does not know is ignored there rather than guessed at, so the
 * failure mode of drift is "nothing happens", not "user lands somewhere
 * wrong".
 */
export const NAVIGATION_DESTINATIONS = [
  'home',
  'planner',
  'inbox',
  'insights',
  'campaigns',
  'campaigns-new',
  'library',
  'compose',
  'drafts',
  'channels',
  'connect-channel',
  'settings-profile',
  'settings-preferences',
  'settings-notifications',
  'settings-general',
  'settings-team',
  'settings-billing',
  'settings-plans',
  'settings-calendar',
  'settings-tags',
  'settings-saved-replies',
] as const;

/** What each destination is for, so the model picks by intent, not by name. */
const DESTINATION_HELP = [
  'home — the dashboard overview',
  'planner — the calendar and scheduled posts',
  'inbox — comments and DMs',
  'insights — analytics and performance',
  'campaigns — the campaign list',
  'campaigns-new — start a new campaign',
  'library — media, templates, snippets, tag groups',
  'compose — write a new post',
  'drafts — saved drafts',
  'channels — connected social accounts',
  'connect-channel — connect a new social account',
  'settings-profile — THEIR OWN name, avatar/profile picture, password',
  'settings-preferences — personal app preferences',
  'settings-notifications — what they get notified about',
  'settings-general — workspace name, timezone, defaults',
  'settings-team — members and invitations',
  'settings-billing — payment method, invoices, current plan',
  'settings-plans — compare and change plan',
  'settings-calendar — calendar connections (Google/Outlook)',
  'settings-tags — hashtag groups',
  'settings-saved-replies — canned inbox replies',
].join('\n  ');

export function createNavigateTools(): AgentToolDefinition[] {
  return [
    {
      name: 'navigate_to',
      description: `Take the user to a page in Schedura. The app moves there immediately, so call this INSTEAD of describing where to click — "go to Settings, then Profile" is a worse answer than simply opening it.

Use it when they ask where something is, how to do something that lives on a specific screen, or to be taken somewhere ("where do I change my profile picture", "open my drafts", "take me to billing").

Do NOT use it to show one specific post, campaign, channel or conversation — those are entity references: cite them with [[ref:<id>]] and the user gets a link they can click. This tool is for PAGES.

Do NOT navigate away mid-task. If they are composing a post or filling something in, answer in words instead — moving the page would lose what they were doing.

After calling it, say in one short line what you opened and what to do there. Destinations:
  ${DESTINATION_HELP}`,
      inputSchema: {
        destination: z
          .enum(NAVIGATION_DESTINATIONS)
          .describe('Which page to open.'),
        reason: z
          .string()
          .optional()
          .describe(
            'A few words on why, shown to the user, e.g. "to change your profile picture".',
          ),
      },
      handler: async (args) => {
        const destination = String(args.destination ?? '');
        // The enum is enforced by the schema, but a model can still send an
        // unlisted string when a provider skips validation. Refusing here
        // keeps a bad name from reaching the client as a real instruction.
        if (
          !(NAVIGATION_DESTINATIONS as readonly string[]).includes(destination)
        ) {
          return {
            kind: 'navigate' as const,
            ok: false,
            error: `Unknown destination "${destination}". Pick one of: ${NAVIGATION_DESTINATIONS.join(', ')}.`,
          };
        }

        const reason =
          typeof args.reason === 'string' ? args.reason.slice(0, 120) : '';

        return {
          kind: 'navigate' as const,
          ok: true,
          destination,
          ...(reason ? { reason } : {}),
        };
      },
    },
  ];
}
