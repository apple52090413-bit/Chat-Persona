// 簡單的後台登入機制：一組密碼（存在 ADMIN_PASSWORD secret），
// 登入成功後發一個有效期 12 小時、用 HMAC-SHA256 簽名的 token，
// 之後每個 /admin/* 請求都要帶著這個 token 驗證。
// 這不是給多人多帳號用的系統，只是給網站擁有者自己用的後台鎖。

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueToken(secret, payload) {
  const body = JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS });
  const bodyB64 = toBase64Url(new TextEncoder().encode(body));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return bodyB64 + '.' + sigB64;
}

export async function verifyToken(secret, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [bodyB64, sigB64] = token.split('.');
  const key = await hmacKey(secret);
  const expectedSig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64)));
  const givenSig = fromBase64Url(sigB64);
  if (expectedSig.length !== givenSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ givenSig[i];
  if (diff !== 0) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(bodyB64)));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
