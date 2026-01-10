import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

export class CreatePostDto {
    @IsString()
    @IsNotEmpty()
    content: string;

    @IsString()
    @IsOptional()
    imageUrl?: string;

    @IsArray()
    @IsOptional()
    platforms?: string[];

    @IsString()
    @IsOptional()
    scheduledAt?: string;
}