import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const SHORTCUT = /^[a-z0-9-]{1,32}$/;

export class CreateSavedReplyDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsString()
  @Matches(SHORTCUT)
  shortcut!: string;

  @IsString()
  @Length(1, 5000)
  body!: string;
}

export class UpdateSavedReplyDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(SHORTCUT)
  shortcut?: string;

  @IsOptional()
  @IsString()
  @Length(1, 5000)
  body?: string;
}

export class ListSavedRepliesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}
