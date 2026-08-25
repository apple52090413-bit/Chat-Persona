export const MAX_TEXT_CHARS = 60000;
export const MAX_IMAGES = 8;

export function truncateText(text) {
  if (!text) return '';
  if (text.length <= MAX_TEXT_CHARS) return text;
  // Keep the most recent part of the conversation, matching the
  // "超過只取最近的部分" behavior described in the upload UI.
  return text.slice(text.length - MAX_TEXT_CHARS);
}

export function validateImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => img && typeof img.data === 'string' && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/'))
    .slice(0, MAX_IMAGES);
}
