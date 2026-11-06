export const ALT_TEXT_SYSTEM_PROMPT =
  "You write alt text for images that will be posted on social media. Describe what matters to someone who cannot see the image: the subject, the action, and any visible text. One sentence, at most 125 characters. Do not start with 'Image of' or 'Picture of'. Reply with the alt text only.";

export const ALT_TEXT_USER_PROMPT = 'Write alt text for this image.';

const MAX_ALT_TEXT_LENGTH = 250;
const CLOUDINARY_IMAGE_UPLOAD = '/image/upload/';

/** Ask Cloudinary for a small JPEG so the vision model gets a bounded payload. */
export function visionImageUrl(fileUrl: string): string {
  const at = fileUrl.indexOf(CLOUDINARY_IMAGE_UPLOAD);
  if (at === -1) return fileUrl;
  const end = at + CLOUDINARY_IMAGE_UPLOAD.length;
  return `${fileUrl.slice(0, end)}f_jpg,w_1024,c_limit/${fileUrl.slice(end)}`;
}

/** Tidy a model reply into alt text: no quotes, no preamble, one line, <= 250 chars. */
export function cleanAltText(raw: string): string {
  let text = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  text = text.replace(/^alt text:\s*/i, '');
  text = text.replace(/^(image|picture) of\s+/i, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_ALT_TEXT_LENGTH) return text;
  const cut = text.slice(0, MAX_ALT_TEXT_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}
