import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
import { browserSession } from '@microsoft/rayfin-auth';
import { signInWithEntraToken } from '@microsoft/rayfin-auth-provider-fabric';
import { functionsService } from '@microsoft/rayfin-functions';
import { EncryptJWT, importJWK, base64url } from 'jose';
import { z } from 'zod';
import type { AppFunctionsSchema } from '../rayfin/functions/src/types';
import { liveRunSchema, type ExecutionRequest, type LiveRunRecord } from '../rayfin/functions/src/contracts';
import type { TenantSession } from './tenantAuth';

export interface LiveBackend {
  execute(request: ExecutionRequest): Promise<LiveRunRecord>;
  history(cursor?: string): Promise<{ records: LiveRunRecord[]; cursor: string }>;
  dispose(): void;
}

export async function createLiveBackend(session: TenantSession): Promise<LiveBackend> {
  const getExecutionToken = session.getExecutionToken;
  if (!getExecutionToken) throw new Error('Reconnect your Microsoft account to enable inventory and live actions together.');
  const token = await getExecutionToken();
  const resolved = await resolveRayfinConfig({ apiUrl: import.meta.env.VITE_RAYFIN_API_URL, publishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY });
  if (!resolved.baseUrl || !resolved.publishableKey) throw new Error('The authenticated execution backend has not been configured.');
  const client = RayfinClient.create({
    baseUrl: resolved.baseUrl, publishableKey: resolved.publishableKey, runtimeConfig: resolved.runtimeConfig,
    auth: browserSession({ storage: false }), services: { functions: functionsService<AppFunctionsSchema>() },
  });
  try {
    const signedIn = await signInWithEntraToken(client.auth, { entraToken: token });
    if (!signedIn.isAuthenticated || !signedIn.user) throw new Error('Execution backend sign-in did not return a user.');
    const subject = signedIn.user.id;
    const { jwk } = z.object({ jwk: z.object({ kty: z.literal('RSA'), n: z.string(), e: z.string(), kid: z.string() }) })
      .parse(JSON.parse((await client.functions.executionKey.invoke()).json));
    const key = await importJWK(jwk, 'RSA-OAEP-256');
    return {
      async execute(input) {
        const request = JSON.stringify(input);
        const requestHash = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request))));
        const userToken = await getExecutionToken();
        const delegation = await new EncryptJWT({ token: userToken, requestHash })
          .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: jwk.kid })
          .setSubject(subject).setIssuedAt().setExpirationTime('90s').setJti(crypto.randomUUID()).encrypt(key);
        const result = await client.functions.executeLive.invoke({ request, delegation }, { timeoutMs: 240_000 });
        return liveRunSchema.parse(JSON.parse(result.json));
      },
      async history(cursor = '') {
        return z.object({ records: z.array(liveRunSchema), cursor: z.string() })
          .parse(JSON.parse((await client.functions.executionHistory.invoke({ cursor })).json));
      },
      dispose() { client.auth.destroy(); },
    };
  } catch (error) { client.auth.destroy(); throw error; }
}
