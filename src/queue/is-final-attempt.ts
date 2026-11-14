/** True once BullMQ has used every attempt (attemptsMade counts the one that just failed). */
export function isFinalAttempt(job: {
  attemptsMade: number;
  opts: { attempts?: number };
}): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
