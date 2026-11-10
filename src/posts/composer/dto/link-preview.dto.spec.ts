import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LinkPreviewQueryDto } from './link-preview.dto';

describe('LinkPreviewQueryDto', () => {
  const errors = (url: unknown) =>
    validateSync(plainToInstance(LinkPreviewQueryDto, { url }));

  it('takes an https link', () => {
    expect(errors('https://lumiere.pk/menu?x=1')).toHaveLength(0);
  });

  it('refuses http, other schemes, a bare host and nothing at all', () => {
    expect(errors('http://lumiere.pk')).not.toHaveLength(0);
    expect(errors('file:///etc/passwd')).not.toHaveLength(0);
    expect(errors('lumiere.pk')).not.toHaveLength(0);
    expect(errors(undefined)).not.toHaveLength(0);
  });

  it('refuses a link over 2048 characters', () => {
    expect(errors(`https://a.example/${'x'.repeat(2048)}`)).not.toHaveLength(0);
  });
});
