import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** Body for POST /schedule and POST /unschedule. A week has 5 posts; 20 leaves headroom. */
export class PostIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  postIds!: string[];
}
