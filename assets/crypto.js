const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KDF_DEFAULT_ITERATIONS = 600000;
export const MIN_PASSPHRASE_LENGTH = 12;
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

export function b64encode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function deriveKey(passphrase, saltB64, iterations = KDF_DEFAULT_ITERATIONS) {
  const salt = b64decode(saltB64);
  const material = await subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBytes(key, input) {
  const iv = randomBytes(IV_BYTES);
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const output = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(ciphertext), IV_BYTES);
  return output;
}

export async function decryptBytes(key, input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength <= IV_BYTES) throw new Error('INVALID_CIPHERTEXT');
  const iv = bytes.subarray(0, IV_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

export async function encryptJson(key, value) {
  return encryptBytes(key, encoder.encode(JSON.stringify(value)));
}

export async function decryptJson(key, input) {
  const plaintext = await decryptBytes(key, input);
  return JSON.parse(decoder.decode(plaintext));
}

export function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`PASSPHRASE_TOO_SHORT:${MIN_PASSPHRASE_LENGTH}`);
  }
}
