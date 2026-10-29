import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

export class CreateNoteDto {
  @IsString()
  @Length(1, 5000)
  @Matches(/\S/, { message: 'body must not be blank' })
  body!: string;

  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(20)
  mentionUserIds!: string[];
}
