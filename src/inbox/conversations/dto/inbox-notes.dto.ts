import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class CreateNoteDto {
  @IsString()
  @Length(1, 5000)
  body!: string;

  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(20)
  mentionUserIds!: string[];
}
