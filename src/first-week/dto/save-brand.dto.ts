import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const NOT_BLANK = /\S/;

/** PUT /workspaces/:id/first-week/brand. Limits are the spec's. */
export class SaveBrandDto {
  @IsString()
  @Matches(NOT_BLANK, { message: 'sells must not be blank' })
  @MaxLength(120)
  sells!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Matches(NOT_BLANK, {
    each: true,
    message: 'each voice chip must not be blank',
  })
  @MaxLength(24, { each: true })
  voice!: string[];

  @IsString()
  @Matches(NOT_BLANK, { message: 'audience must not be blank' })
  @MaxLength(200)
  audience!: string;
}
