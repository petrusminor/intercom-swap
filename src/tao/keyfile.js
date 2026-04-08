import fs from 'node:fs';

export function readTaoPrivateKeyFromFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    throw new Error(`Failed to read TAO keyfile: ${filePath}`);
  }

  const privateKey = String(raw || '').trim();
  if (!privateKey.startsWith('0x')) {
    throw new Error('TAO keyfile must contain a 0x-prefixed 32-byte hex private key');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('TAO keyfile must contain a 0x-prefixed 32-byte hex private key');
  }
  return privateKey;
}
