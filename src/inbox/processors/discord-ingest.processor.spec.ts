import { classifyDiscordAttachment } from './discord-ingest.processor';

describe('classifyDiscordAttachment', () => {
  it('maps image content types', () => {
    expect(classifyDiscordAttachment('image/png')).toEqual({
      r2Kind: 'image',
      dmKind: 'image',
    });
  });

  it('maps video content types', () => {
    expect(classifyDiscordAttachment('video/mp4')).toEqual({
      r2Kind: 'video',
      dmKind: 'video',
    });
  });

  it('maps audio to voice', () => {
    expect(classifyDiscordAttachment('audio/ogg')).toEqual({
      r2Kind: 'voice',
      dmKind: 'voice',
    });
  });

  it('falls back to file for unknown / missing content type', () => {
    expect(classifyDiscordAttachment(undefined)).toEqual({
      r2Kind: 'file',
      dmKind: 'file',
    });
    expect(classifyDiscordAttachment('application/pdf')).toEqual({
      r2Kind: 'file',
      dmKind: 'file',
    });
  });
});
