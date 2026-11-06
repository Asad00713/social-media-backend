import { IsBoolean } from 'class-validator';

/** Body for `PUT .../drafts/:draftId/approval` — the "Needs approval" switch. */
export class SetApprovalDto {
  @IsBoolean()
  required!: boolean;
}
