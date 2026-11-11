// Web push: notifications on phones (the app added to the Home Screen) and desktops, even with Cadence closed.
// No library: payloads are encrypted per RFC 8291 (aes128gcm) and requests signed per RFC 8292 (VAPID), with
// node:crypto. The server's VAPID key pair is made once and kept in the accounts database.
import {createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign} from 'node:crypto';

export type Vapid = {publicKey: string; privateJwk: JsonWebKey};
export type PushSub = {endpoint: string; p256dh: string; auth: string};
export type PushMessage = {title: string; body: string; url: string; tag?: string; unread?: number};

/** A new VAPID key pair. The public key is the raw P-256 point, base64url, as browsers want it. */
export function makeVapid(): Vapid {
  const jwk = generateKeyPairSync('ec', {namedCurve: 'P-256'}).privateKey.export({format: 'jwk'});
  return {publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'), privateJwk: jwk};
}

/** RFC 8291 encryption of one push message. Sender key and salt are fresh each time unless given (tests). */
export function encrypt(payload: Buffer, uaPublic: Buffer, authSecret: Buffer, asPrivate?: Buffer, salt = randomBytes(16)) {
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(uaPublic), authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/** The VAPID Authorization header for a push service. */
export function vapidHeader(endpoint: string, v: Vapid, subject: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({typ: 'JWT', alg: 'ES256'})}.${b64({aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject})}`;
  const sig = sign('sha256', Buffer.from(unsigned), {key: createPrivateKey({key: v.privateJwk, format: 'jwk'}), dsaEncoding: 'ieee-p1363'});
  return `vapid t=${unsigned}.${sig.toString('base64url')}, k=${v.publicKey}`;
}

/**
 * Only real push services, so a subscription cannot make the server post to an address of someone's choosing.
 * Google (Chrome, Edge on Android), Mozilla, Apple (Safari, iPhone apps on the Home Screen), Microsoft (Edge).
 */
export function isPushService(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(u.hostname);
  } catch { return false; }
}

/** How messages leave the server; tests swap it. */
export const transport = {post: (url: string, init: RequestInit) => fetch(url, init).then(r => r.status)};

/** Sends one message. Returns the push service's status: 201 sent, 404 or 410 means the subscription is gone. */
export function send(sub: PushSub, msg: PushMessage, v: Vapid, subject: string) {
  return transport.post(sub.endpoint, {
    method: 'POST',
    headers: {'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal', authorization: vapidHeader(sub.endpoint, v, subject)},
    body: encrypt(Buffer.from(JSON.stringify(msg)), Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url')),
  });
}
