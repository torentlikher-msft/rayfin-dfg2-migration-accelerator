import { generateKeyPairSync, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EncryptJWT, importJWK } from 'jose';
import { assertDelegatedCaller, decryptDelegation, delegationKey } from '../rayfin/functions/src/delegation';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const secret = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
const key = delegationKey(secret);
const request = '{"action":"assess","workspaceId":"workspace"}';
async function encrypt(subject = 'caller', body = request, expired = false) {
  return new EncryptJWT({ token: 'delegated-user-token', requestHash: createHash('sha256').update(body).digest('base64url') })
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: key.kid }).setSubject(subject)
    .setIssuedAt(expired ? Math.floor(Date.now() / 1000) - 300 : undefined)
    .setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 200 : '90s')
    .encrypt(await importJWK(key.jwk, 'RSA-OAEP-256'));
}
afterEach(() => vi.unstubAllGlobals());

describe('caller-bound delegated execution', () => {
  it('encrypts the token and binds the caller, exact request, expiry, and current key', async () => {
    const encrypted = await encrypt();
    expect(encrypted).not.toContain('delegated-user-token');
    expect(await decryptDelegation(request, encrypted, 'caller', secret)).toBe('delegated-user-token');
    await expect(decryptDelegation(request + ' ', encrypted, 'caller', secret)).rejects.toThrow('does not match');
    await expect(decryptDelegation(request, encrypted, 'another-caller', secret)).rejects.toThrow();
    await expect(decryptDelegation(request, await encrypt('caller', request, true), 'caller', secret)).rejects.toThrow();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const otherSecret = Buffer.from(other.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
    await expect(decryptDelegation(request, encrypted, 'caller', otherSecret)).rejects.toThrow();
  });

  it('binds the Microsoft credential using a real SDK exchange, never an unverified oid or the owner token', async () => {
    const jwt = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ sub: 'actual-user', email: 'user@example.test', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-signature'].join('.');
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://backend.example.test/app/api/auth/v1/brokered/token');
      expect(request.headers.get('authorization')).toBe('Bearer delegated-user-token');
      return Response.json({ accessToken: jwt, tokenType: 'Bearer', expiresIn: 3600 });
    });
    vi.stubGlobal('fetch', fetch);
    await assertDelegatedCaller('delegated-user-token', 'actual-user', 'https://backend.example.test/app', 'pk-test');
    await expect(assertDelegatedCaller('delegated-user-token', 'different-user', 'https://backend.example.test/app', 'pk-test')).rejects.toThrow('does not match');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
