import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { emailSuppressions } from '../../drizzle/schema/email-suppressions.schema';

export type SuppressionReason = 'bounced' | 'complained';

/** Rows are keyed by the lowercased address, so lookups lowercase too. */
const normalise = (email: string) => email.trim().toLowerCase();

@Injectable()
export class EmailSuppressionRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async isSuppressed(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.email, normalise(email)))
      .limit(1);
    return rows.length > 0;
  }

  /** Insert, or overwrite the reason and message id of an existing row. */
  async suppress(
    email: string,
    reason: SuppressionReason,
    resendEmailId: string | null,
  ): Promise<void> {
    await this.db
      .insert(emailSuppressions)
      .values({ email: normalise(email), reason, resendEmailId })
      .onConflictDoUpdate({
        target: emailSuppressions.email,
        set: { reason, resendEmailId, updatedAt: sql`now()` },
      });
  }
}
