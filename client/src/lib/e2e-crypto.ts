const DB_NAME = "stillhere_e2e";
const STORE_NAME = "keys";
const KEY_ID = "my_keypair";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeKey(id: string, value: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getKey(id: string): Promise<any> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getOrCreateKeyPair(): Promise<{ publicKey: JsonWebKey; privateKey: CryptoKey }> {
  const existing = await getKey(KEY_ID);
  if (existing) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      existing.privateKeyJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    return { publicKey: existing.publicKeyJwk, privateKey };
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  await storeKey(KEY_ID, { publicKeyJwk, privateKeyJwk });

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );

  return { publicKey: publicKeyJwk, privateKey };
}

export function exportPublicKeyString(jwk: JsonWebKey): string {
  return JSON.stringify(jwk);
}

async function deriveSharedKey(privateKey: CryptoKey, otherPublicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  const otherPublicKey = await crypto.subtle.importKey(
    "jwk",
    otherPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: otherPublicKey },
    privateKey,
    256
  );

  return crypto.subtle.importKey(
    "raw",
    sharedBits,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const sharedKeyCache = new Map<string, CryptoKey>();

async function getSharedKey(privateKey: CryptoKey, otherPublicKeyStr: string): Promise<CryptoKey> {
  const cached = sharedKeyCache.get(otherPublicKeyStr);
  if (cached) return cached;

  const otherJwk = JSON.parse(otherPublicKeyStr) as JsonWebKey;
  const key = await deriveSharedKey(privateKey, otherJwk);
  sharedKeyCache.set(otherPublicKeyStr, key);
  return key;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function encryptMessage(
  plaintext: string,
  privateKey: CryptoKey,
  otherPublicKeyStr: string
): Promise<{ ciphertext: string; iv: string }> {
  const sharedKey = await getSharedKey(privateKey, otherPublicKeyStr);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sharedKey,
    encoded
  );

  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv.buffer),
  };
}

export async function decryptMessage(
  ciphertext: string,
  ivStr: string,
  privateKey: CryptoKey,
  otherPublicKeyStr: string
): Promise<string> {
  const sharedKey = await getSharedKey(privateKey, otherPublicKeyStr);
  const iv = new Uint8Array(base64ToArrayBuffer(ivStr));
  const data = base64ToArrayBuffer(ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    sharedKey,
    data
  );

  return new TextDecoder().decode(decrypted);
}
