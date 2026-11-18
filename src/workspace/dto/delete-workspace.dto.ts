import { IsString, MaxLength } from 'class-validator';

/**
 * The typed confirm of a permanent workspace delete. The service compares
 * `confirmName.trim()` to the workspace name exactly (case-sensitive), so
 * the check itself lives there, next to the 400 it answers.
 */
export class DeleteWorkspaceDto {
  @IsString()
  // A workspace name is varchar(255); anything longer can never match.
  @MaxLength(1000)
  confirmName!: string;
}
