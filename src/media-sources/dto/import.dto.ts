import { IsIn, IsString, MinLength } from 'class-validator';

export class ImportSourceDto {
  @IsString()
  @MinLength(1)
  fileId: string;

  @IsIn(['image', 'video'])
  kind: 'image' | 'video';
}
