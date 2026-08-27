export const FREE_TEXT_LIMIT = 80000;
export const PAID_TEXT_LIMIT = 600000;
export const MAX_IMAGES = 8;

// 免費版／付費版超過字數上限時直接擋下，不做「只取最近一段」的靜默截斷 ——
// 靜默截斷會讓使用者以為分析涵蓋了全部內容，但其實 AI 根本沒讀到前面的部分。
export function assertWithinTextLimit(text, limit) {
  if (text && text.length > limit) {
    const err = new Error(`內容有 ${text.length.toLocaleString()} 字，超過 ${limit.toLocaleString()} 字上限`);
    err.status = 400;
    err.isValidation = true;
    err.code = 'TEXT_TOO_LONG';
    err.charCount = text.length;
    err.limit = limit;
    throw err;
  }
}

export function validateImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => img && typeof img.data === 'string' && typeof img.mediaType === 'string' && img.mediaType.startsWith('image/'))
    .slice(0, MAX_IMAGES);
}
