import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { Auth } from '@microsoft/rayfin-auth';
import { ApiClient } from '@microsoft/rayfin-lib';
import { signInWithEntraToken } from '@microsoft/rayfin-auth-provider-fabric';
import { importPKCS8, jwtDecrypt } from 'jose';
import { z } from 'zod';

export function delegationKey(secret: string) {
  const pem = Buffer.from(secret, 'base64').toString('utf8');
  const publicKey = createPublicKey(createPrivateKey(pem));
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('base64url');
  return { pem, jwk: { ...jwk, alg: 'RSA-OAEP-256', use: 'enc', kid }, kid };
}

export async function decryptDelegation(request: string, delegation: string, subject: string, secret: string): Promise<string> {
  const key = delegationKey(secret);
  const decrypted = await jwtDecrypt(delegation, await importPKCS8(key.pem, 'RSA-OAEP-256'), {
    keyManagementAlgorithms: ['RSA-OAEP-256'], contentEncryptionAlgorithms: ['A256GCM'],
    subject, maxTokenAge: '2m', clockTolerance: 5,
  });
  if (decrypted.protectedHeader.kid !== key.kid) throw new Error('Delegation key rotated. Reconnect execution and retry.');
  const claims = z.object({ token: z.string().min(1), requestHash: z.string() }).parse(decrypted.payload);
  if (claims.requestHash !== createHash('sha256').update(request).digest('base64url')) throw new Error('Delegation does not match the execution request.');
  return claims.token;
}

export async function assertDelegatedCaller(token: string, subject: string, baseUrl: string, publishableKey: string): Promise<void> {
  const auth = new Auth(new ApiClient({ baseUrl, publishableKey }), { storage: false });
  try {
    const session = await signInWithEntraToken(auth, { entraToken: token });
    if (!session.isAuthenticated || session.user?.id !== subject) throw new Error('Delegated Microsoft account does not match the signed-in caller.');
  } finally { auth.destroy(); }
}
