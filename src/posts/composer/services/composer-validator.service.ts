import { Injectable } from '@nestjs/common';
import type { PublicationPayload } from '../types/publication-payload.types';
import type { ComposerCapabilities } from '../types/composer-capabilities.types';
import { MediaValidatorService } from './media-validator.service';

export interface ComposerValidationError {
  kind:
    | 'body_too_long'
    | 'body_near_limit'
    | 'title_too_long'
    | 'description_too_long'
    | 'first_comment_too_long'
    | 'required_field_missing'
    | 'unsupported_feature'
    | 'media_invalid';
  field?: string;
  message: string;
}

export interface ComposerValidationResult {
  ok: boolean;
  errors: ComposerValidationError[];
  warnings: ComposerValidationError[];
}

const WARNING_THRESHOLD = 0.9;

@Injectable()
export class ComposerValidatorService {
  constructor(private readonly mediaValidator: MediaValidatorService) {}

  validate(payload: PublicationPayload, caps: ComposerCapabilities): ComposerValidationResult {
    const errors: ComposerValidationError[] = [];
    const warnings: ComposerValidationError[] = [];

    if (caps.supportsBody) {
      if (payload.text.length > caps.maxCharsBody) {
        errors.push({
          kind: 'body_too_long',
          field: 'body',
          message: `Body ${payload.text.length} chars exceeds ${caps.maxCharsBody}`,
        });
      } else if (
        caps.maxCharsBody > 0 &&
        payload.text.length / caps.maxCharsBody >= WARNING_THRESHOLD
      ) {
        warnings.push({
          kind: 'body_near_limit',
          field: 'body',
          message: `Body close to ${caps.maxCharsBody} char limit`,
        });
      }
    }

    for (const required of caps.requiredFields) {
      const present = this.fieldPresent(required, payload);
      if (!present) {
        errors.push({
          kind: 'required_field_missing',
          field: required,
          message: `Required field '${required}' is missing or empty`,
        });
      }
    }

    const title = (payload.platformSpecific.title as string | undefined) ?? '';
    if (caps.supportsTitle && caps.maxCharsTitle && title.length > caps.maxCharsTitle) {
      errors.push({
        kind: 'title_too_long',
        field: 'title',
        message: `Title ${title.length} chars exceeds ${caps.maxCharsTitle}`,
      });
    }

    const desc = (payload.platformSpecific.description as string | undefined) ?? '';
    if (
      caps.supportsDescription &&
      caps.maxCharsDescription &&
      desc.length > caps.maxCharsDescription
    ) {
      errors.push({
        kind: 'description_too_long',
        field: 'description',
        message: `Description ${desc.length} chars exceeds ${caps.maxCharsDescription}`,
      });
    }

    const mediaResult = this.mediaValidator.validate(payload.mediaItems, caps.mediaConstraints);
    for (const e of mediaResult.errors) {
      errors.push({ kind: 'media_invalid', field: 'media', message: e.message });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  private fieldPresent(field: string, payload: PublicationPayload): boolean {
    switch (field) {
      case 'body':
        return payload.text.trim().length > 0;
      case 'title':
        return Boolean((payload.platformSpecific.title as string | undefined)?.trim());
      case 'description':
        return Boolean((payload.platformSpecific.description as string | undefined)?.trim());
      case 'image':
        return payload.mediaItems.some((m) => m.type === 'image');
      case 'video':
        return payload.mediaItems.some((m) => m.type === 'video');
      case 'board':
        return Boolean((payload.platformSpecific.boardId as string | undefined)?.trim());
      default:
        return Boolean((payload.platformSpecific as Record<string, unknown>)[field]);
    }
  }
}
