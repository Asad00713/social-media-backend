import type { FeedbackType } from 'src/drizzle/schema';

/** A user must have used the product for a month before their rating means anything. */
export const FEEDBACK_MIN_ACCOUNT_AGE_DAYS = 30;

/** Quarterly is the standard relational-survey cadence. */
export const FEEDBACK_SUBMIT_COOLDOWN_DAYS = 90;

/**
 * Shorter than the submit window: a dismissal is weaker evidence than an
 * answer. Not shorter still — short snooze windows produce repeat dismissals
 * and train people to close the widget reflexively.
 */
export const FEEDBACK_DISMISS_COOLDOWN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PromptInput {
  accountCreatedAt: Date;
  /** Newest review across ALL types — the throttle is per user, not per type. */
  latestReviewAt: Date | null;
  /** Newest dismissal across ALL types. */
  latestDismissalAt: Date | null;
  latestByType: { app: Date | null; maestro: Date | null };
  now: Date;
}

export interface PromptDecision {
  prompt: FeedbackType | null;
  nextEligibleAt: Date | null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Whether this user may be prompted for feedback right now, and for which type.
 *
 * Deliberately answers ONE question for the whole user rather than one per
 * type: the industry guardrail is "no more than one survey per 90 days per
 * contact", and two independent per-type cycles would let both prompts land in
 * the same week — exactly the survey fatigue the cadence exists to prevent.
 *
 * Pure and date-injected so the cadence can be tested without waiting 90 days.
 */
export function promptFor(input: PromptInput): PromptDecision {
  const { accountCreatedAt, latestReviewAt, latestDismissalAt, now } = input;

  // Each gate contributes the time at which it stops blocking.
  const gates: Date[] = [
    addDays(accountCreatedAt, FEEDBACK_MIN_ACCOUNT_AGE_DAYS),
  ];
  if (latestReviewAt) {
    gates.push(addDays(latestReviewAt, FEEDBACK_SUBMIT_COOLDOWN_DAYS));
  }
  if (latestDismissalAt) {
    gates.push(addDays(latestDismissalAt, FEEDBACK_DISMISS_COOLDOWN_DAYS));
  }

  // The most restrictive gate wins.
  const nextEligibleAt = gates.reduce((latest, g) =>
    g > latest ? g : latest,
  );

  if (now < nextEligibleAt) {
    return { prompt: null, nextEligibleAt };
  }

  return { prompt: pickType(input), nextEligibleAt: null };
}

/**
 * Prefer a type never rated; otherwise the one rated longest ago. Ties and the
 * blank-slate case go to `app` — it is the broader signal and lives on the more
 * discoverable surface.
 */
function pickType(input: PromptInput): FeedbackType {
  const { app, maestro } = input.latestByType;

  if (app === null) return 'app';
  if (maestro === null) return 'maestro';
  return app <= maestro ? 'app' : 'maestro';
}
