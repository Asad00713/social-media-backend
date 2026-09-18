import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListCommentsDto } from './dto/list-comments.dto';

function validate(obj: Record<string, unknown>) {
  const dto = plainToInstance(ListCommentsDto, obj);
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { errors, dto };
}

describe('ListCommentsDto query contract', () => {
  // These are exactly the params the frontend sends. `sort` used to be absent
  // from the DTO, so ValidationPipe's whitelist rejected the whole request
  // with "property sort should not exist" — a 400 that blanked the inbox.
  it.each(['newest', 'oldest', 'unanswered'])('accepts sort=%s', (sort) => {
    expect(validate({ sort }).errors).toHaveLength(0);
  });

  it('rejects an unknown sort', () => {
    expect(validate({ sort: 'bogus' }).errors.length).toBeGreaterThan(0);
  });

  it('accepts a search query and trims it', () => {
    const { errors, dto } = validate({ q: '  webinar  ' });
    expect(errors).toHaveLength(0);
    expect(dto.q).toBe('webinar');
  });

  it('accepts folder=replied', () => {
    expect(validate({ folder: 'replied' }).errors).toHaveLength(0);
  });

  it('rejects an unknown folder', () => {
    expect(validate({ folder: 'bogus' }).errors.length).toBeGreaterThan(0);
  });

  it('accepts the full combination the list hooks send', () => {
    expect(
      validate({ folder: 'unread', sort: 'unanswered', q: 'ab', limit: 20 })
        .errors,
    ).toHaveLength(0);
  });
});
