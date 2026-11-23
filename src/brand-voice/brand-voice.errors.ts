import { BadRequestException, ConflictException } from '@nestjs/common';

/**
 * The brand-voice error bodies, in the `{ statusCode, error, code, message }`
 * shape the labels API uses, so the client can branch on `code`.
 */

/** A save or Undo named a version that is no longer the stored one. */
export const versionConflict = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'VERSION_CONFLICT',
    message: 'Someone else just changed the brand voice. Reload to see it.',
  });

/** Undo with no snapshot left: never saved, or already undone once. */
export const nothingToUndo = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'NOTHING_TO_UNDO',
    message: 'There is nothing to undo.',
  });

/** A save that carried only the version. */
export const nothingToSave = () =>
  new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'NOTHING_TO_SAVE',
    message: 'Send at least one field to change.',
  });
