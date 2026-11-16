/**
 * Where `npm run email:preview` loads assets from: EMAIL_ASSET_BASE_URL, else
 * the local frontend. Preview fixtures only; production renders take the
 * base from AppLinks.
 */
export const PREVIEW_ASSET_BASE =
  process.env.EMAIL_ASSET_BASE_URL ?? 'http://localhost:3001/email';

/** A post thumbnail the frontend ships for previews (`preview-thumbnail.png`). */
export const PREVIEW_THUMBNAIL_URL = `${PREVIEW_ASSET_BASE}/preview-thumbnail.png`;
