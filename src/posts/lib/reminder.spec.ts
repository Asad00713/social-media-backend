import {
  isReminderTarget,
  REMINDER_CAPTION_MAX,
  reminderContent,
  reminderText,
} from './reminder';

const remind = { platformSpecific: { publishMode: 'remind' } };

describe('isReminderTarget', () => {
  it('is true only for Instagram or Facebook set to remind', () => {
    expect(isReminderTarget('instagram', { instagram: remind })).toBe(true);
    expect(isReminderTarget('facebook', { facebook: remind })).toBe(true);
  });

  it('publishes automatically for anything else', () => {
    expect(isReminderTarget('instagram', undefined)).toBe(false);
    expect(isReminderTarget('instagram', {})).toBe(false);
    expect(
      isReminderTarget('instagram', {
        instagram: { platformSpecific: { publishMode: 'auto' } },
      }),
    ).toBe(false);
    expect(
      isReminderTarget('instagram', {
        instagram: { platformSpecific: { publishMode: 'REMIND' } },
      }),
    ).toBe(false);
    // Another platform's setting does not leak across.
    expect(isReminderTarget('instagram', { facebook: remind })).toBe(false);
    // A network not offered the mode ignores the key.
    expect(isReminderTarget('linkedin', { linkedin: remind })).toBe(false);
  });
});

describe('reminderContent', () => {
  const post = {
    content: 'shared caption',
    mediaItems: [{ url: 'https://cdn/a.jpg' }, { url: '' }, {}],
    platformContent: {},
  };

  it('uses the shared caption and media, dropping empty urls', () => {
    expect(reminderContent('instagram', post)).toEqual({
      platform: 'instagram',
      caption: 'shared caption',
      mediaUrls: ['https://cdn/a.jpg'],
    });
  });

  it("uses the channel's own edit and its frame note", () => {
    expect(
      reminderContent('instagram', {
        ...post,
        platformContent: {
          instagram: {
            overrides: {
              text: 'ig caption',
              mediaItems: [{ url: 'https://cdn/story.mp4' }],
            },
            platformSpecific: {
              publishMode: 'remind',
              frameNote: '  Link sticker, bottom centre ',
            },
          },
        },
      }),
    ).toEqual({
      platform: 'instagram',
      caption: 'ig caption',
      mediaUrls: ['https://cdn/story.mp4'],
      note: 'Link sticker, bottom centre',
    });
  });

  it('a blank note is no note', () => {
    const c = reminderContent('instagram', {
      ...post,
      platformContent: { instagram: { platformSpecific: { frameNote: ' ' } } },
    });
    expect(c).not.toHaveProperty('note');
  });
});

describe('reminderText', () => {
  it('names the network and copies note, caption and links, in that order', () => {
    expect(
      reminderText({
        platform: 'instagram',
        caption: 'Iced latte',
        mediaUrls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'],
        note: 'Add the poll',
      }),
    ).toEqual({
      title: 'Time to post on Instagram',
      message:
        'Note: Add the poll\n\nIced latte\n\nMedia:\nhttps://cdn/a.jpg\nhttps://cdn/b.jpg',
    });
  });

  it('says something even with nothing to copy', () => {
    expect(
      reminderText({ platform: 'facebook', caption: '', mediaUrls: [] }),
    ).toEqual({
      title: 'Time to post on Facebook',
      message: 'Your Facebook post is ready to go out.',
    });
  });

  it('shortens a very long caption', () => {
    const { message } = reminderText({
      platform: 'instagram',
      caption: 'x'.repeat(REMINDER_CAPTION_MAX + 50),
      mediaUrls: [],
    });
    expect(message.length).toBe(REMINDER_CAPTION_MAX);
    expect(message.endsWith('…')).toBe(true);
  });
});
