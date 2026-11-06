/**
 * The Library's sample content, seeded once into every NEW workspace
 * (LibrarySamplesService). All copy here is ours, invented for the samples.
 *
 * The images are bundled with the API (assets/library-samples/v1/, made by
 * scripts/generate-library-samples.mjs) and served from
 * `${SAMPLE_ASSET_ROUTE}/v1/<file>`: every workspace's sample rows point at
 * the same file. `bytes`, `width` and `height` must match the files on disk;
 * sample-content.spec.ts checks them.
 */
import type { TemplateType } from '../../drizzle/schema/media-library.schema';
import type { SavedLinkUtm } from '../../drizzle/schema/media-library.schema';

/** The folder created in each tab that has samples. */
export const SAMPLE_FOLDER_NAME = 'Getting started';

/**
 * Public route the bundled files are served from. The version is part of the
 * path because the files are cached as immutable: a changed image ships in a
 * new folder (v2/), never over a published one.
 */
export const SAMPLE_ASSET_ROUTE = '/static/library-samples';
export const SAMPLE_ASSET_VERSION = 'v1';

export interface SampleImage {
  file: string;
  name: string;
  altText: string;
  width: number;
  height: number;
  bytes: number;
}

export const SAMPLE_IMAGES: readonly SampleImage[] = [
  {
    file: 'launch-announcement.png',
    name: 'Launch announcement',
    altText:
      'Illustrated launch card with confetti on a blue background, square.',
    width: 1080,
    height: 1080,
    bytes: 19636,
  },
  {
    file: 'product-spotlight.png',
    name: 'Product spotlight',
    altText:
      'Illustrated blue product bottle on a white plinth, light blue background, portrait.',
    width: 1080,
    height: 1350,
    bytes: 22667,
  },
  {
    file: 'behind-the-scenes-story.png',
    name: 'Behind the scenes (story)',
    altText:
      'Vertical story frame with mountains and a sun at dawn, a profile badge and a sticker.',
    width: 1080,
    height: 1920,
    bytes: 35260,
  },
  {
    file: 'event-banner.png',
    name: 'Event banner',
    altText:
      'Wide event banner with a calendar where one day is highlighted in red.',
    width: 1920,
    height: 1080,
    bytes: 28040,
  },
  {
    file: 'quick-tip.png',
    name: 'Quick tip',
    altText: 'Illustrated light bulb on an amber background, square.',
    width: 1080,
    height: 1080,
    bytes: 24999,
  },
  {
    file: 'team-quote.png',
    name: 'Team quote',
    altText:
      'Quote card with large red quote marks, lines of text and an avatar, portrait.',
    width: 1080,
    height: 1350,
    bytes: 21032,
  },
];

export interface SampleTemplate {
  name: string;
  description: string;
  templateType: TemplateType;
  text: string;
  hashtags: string[];
  /** The sample image used as its thumbnail and attached media, if any. */
  imageFile: string;
}

export const SAMPLE_TEMPLATES: readonly SampleTemplate[] = [
  {
    name: 'Product launch announcement',
    description:
      'Announce something new. Fill in the blanks, swap the image, schedule.',
    templateType: 'post',
    text:
      'Big news: {{product_name}} is here.\n\n' +
      '{{one_line_benefit}}\n\n' +
      'Available from {{launch_date}}. Tap the link in our bio to be one of the first to try it.',
    hashtags: ['launch', 'newproduct'],
    imageFile: 'launch-announcement.png',
  },
  {
    name: 'Tip of the week',
    description:
      'A three-step how-to your audience will want to save and share.',
    templateType: 'carousel',
    text:
      'Tip of the week: {{tip_title}}\n\n' +
      '1. {{step_one}}\n' +
      '2. {{step_two}}\n' +
      '3. {{step_three}}\n\n' +
      'Save this post so you have it when you need it.',
    hashtags: ['tips', 'howto'],
    imageFile: 'quick-tip.png',
  },
  {
    name: 'Behind the scenes',
    description: 'A quick story that shows the people and the work.',
    templateType: 'story',
    text:
      'A peek behind the scenes at {{company_name}}: {{what_we_are_working_on}}.\n\n' +
      'Reply and tell us what you would like to see next.',
    hashtags: ['behindthescenes'],
    imageFile: 'behind-the-scenes-story.png',
  },
  {
    name: 'Event invitation',
    description: 'Invite people to a workshop, webinar or in-store event.',
    templateType: 'post',
    text:
      'Join us for {{event_name}} on {{event_date}} at {{event_time}}.\n\n' +
      '{{what_attendees_get}}\n\n' +
      'Save your spot: {{registration_link}}',
    hashtags: ['event'],
    imageFile: 'event-banner.png',
  },
];

export interface SampleSnippet {
  name: string;
  snippetType: 'caption' | 'hashtags' | 'cta';
  content: string;
}

export const SAMPLE_SNIPPETS: readonly SampleSnippet[] = [
  {
    name: 'Weekend opening hours',
    snippetType: 'caption',
    content:
      "We're open this weekend from 10am to 6pm. Drop by, say hello, and ask about this week's specials.",
  },
  {
    name: 'Small business hashtags',
    snippetType: 'hashtags',
    content: '#smallbusiness #shoplocal #behindthescenes #newarrivals',
  },
  {
    name: 'Link in bio',
    snippetType: 'cta',
    content:
      'Tap the link in our bio to learn more, and follow us so you never miss an update.',
  },
];

export interface SampleLink {
  name: string;
  url: string;
  description: string;
  utm: SavedLinkUtm;
  previewTitle: string;
  previewSiteName: string;
}

/**
 * example.com is reserved for documentation (RFC 2606), so the sample never
 * sends people to someone's real site. Its preview fields are written here,
 * not fetched: seeding makes no network call.
 */
export const SAMPLE_LINK: SampleLink = {
  name: 'Your landing page (sample)',
  url: 'https://example.com/',
  description:
    'Replace this with a page you share often, like your shop, booking page or newsletter sign-up. UTM tags are added when you insert it into a post.',
  utm: { source: 'instagram', medium: 'social', campaign: 'getting-started' },
  previewTitle: 'Example Domain',
  previewSiteName: 'example.com',
};
