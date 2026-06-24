import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LeadFormQuestionDto {
  @IsString() type!: string; // 'FULL_NAME' | 'EMAIL' | ... | 'CUSTOM'
  @IsOptional() @IsString() key?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() inputType?: 'TEXT' | 'MULTIPLE_CHOICE';
  @IsOptional() @IsArray() options?: Array<{ key: string; value: string }>;
}

export class LeadFormPrivacyDto {
  @IsUrl({ require_tld: true }) url!: string;
  @IsString() linkText!: string;
}

export class LeadFormThankYouDto {
  @IsString() title!: string;
  @IsString() body!: string;
  @IsOptional()
  @IsIn(['VIEW_WEBSITE', 'CALL_BUSINESS', 'DOWNLOAD'])
  buttonType?: 'VIEW_WEBSITE' | 'CALL_BUSINESS' | 'DOWNLOAD';
  @IsOptional() @IsUrl() websiteUrl?: string;
  @IsOptional() @IsString() buttonText?: string;
}

export class CreateLeadFormDto {
  @IsString() name!: string;
  @IsOptional() @IsString() locale?: string; // default 'en_US'
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LeadFormQuestionDto)
  questions!: LeadFormQuestionDto[];
  @ValidateNested()
  @Type(() => LeadFormPrivacyDto)
  privacyPolicy!: LeadFormPrivacyDto;
  @ValidateNested()
  @Type(() => LeadFormThankYouDto)
  thankYou!: LeadFormThankYouDto;
  @IsOptional() @IsObject() contextCard?: {
    title: string;
    style?: 'LIST_STYLE' | 'PARAGRAPH_STYLE';
    content?: string[];
    buttonText?: string;
  };
}
