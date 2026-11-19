<p align="center">
  <img src="public/favicon.svg" width="112" height="112" alt="Dataflow Migration Studio icon" />
</p>

<h1 align="center">Dataflow Migration Studio</h1>

<p align="center">
  <strong>Discover. Assess. Upgrade. Verify.</strong><br />
  A focused workspace for migrating Power BI Dataflow Gen1 to Microsoft Fabric Dataflow Gen2.
</p>

<p align="center">
  Built with Microsoft Rayfin &nbsp;|&nbsp; React + TypeScript &nbsp;|&nbsp; Microsoft Entra authentication
</p>

<p align="center">
  <a href="#quick-how-to">Quick how-to</a> &nbsp;&bull;&nbsp;
  <a href="#prerequisites">Prerequisites</a> &nbsp;&bull;&nbsp;
  <a href="#setup--deployment">Setup &amp; deployment</a> &nbsp;&bull;&nbsp;
  <a href="#local-development">Local development</a> &nbsp;&bull;&nbsp;
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

**Dataflow Migration Studio** brings live tenant inventory, Microsoft's native readiness assessments, reviewed in-place upgrades, and a durable audit trail into one interface. No sample inventory, simulated migrations, or locally invented compatibility scores are shown.

Already have access to a deployed app? Start with the [quick how-to](#quick-how-to). The deployment owner completes the [setup](#setup--deployment) once per environment.

## At a glance

| Discover & assess | Select & migrate | Track & review |
| --- | --- | --- |
| Inventory grouped by workspace, with total and ready counts. | Workspace selection includes only `ReadyToMigrate`. | Automatic operation tracking and same-ID Gen2 verification. |
| Automatic Microsoft readiness checks for every discovered nonempty workspace. | Individual selection and explicit acknowledgment for `NeedsAttention`. | Account-scoped history with request IDs, outcomes, and retained API evidence. |
| Search, deployment-stage filters, and readiness filters. | Review and confirm every in-place upgrade. | Full dataflow lists in a side panel, API-result drawers, and JSON exports. |

The interface includes a pinned connection toolbar, collapsed-by-default workspaces, scrollable inventory/history, and a persistent light/neutral-grey dark-mode toggle.

> [!IMPORTANT]
> **This app upgrades in place.** Gen1 is replaced with Gen2 and the original ID is retained. It does not keep a separate Gen1 copy or provide rollback. If you need to preserve the original, use a separate save-as migration approach instead. Review Microsoft's [upgrade prerequisites and limitations][upgrade-guide] before proceeding.

## Quick how-to

1. **Connect your tenant.** Open the app, choose **Connect tenant**, then **Sign in with Microsoft**. Use an account in the configured tenant. Inventory and live actions use the same sign-in; there is no separate enablement step.
2. **Let assessments finish.** Workspaces load collapsed, but Microsoft readiness checks run automatically across all discovered nonempty workspaces. Progress appears in the inventory header. Expand a workspace to inspect its dataflows and API reasons.
3. **Find your candidates.** Search by workspace/dataflow and filter by deployment pipeline stage or readiness. Changing search or filters clears the current selection. **Unknown** pipeline stage means membership was not verified, not necessarily that the workspace is unassigned.
4. **Select deliberately.** A workspace checkbox selects only `ReadyToMigrate` items. Select `NeedsAttention` items individually after reviewing the reasons. Blocked, unassessed, converted, and in-flight items cannot be selected for an upgrade.
5. **Review and confirm.** Choose **Migrate selected** beside **Your workspaces**. Acknowledge the in-place behavior and any NeedsAttention follow-ups, then choose **Upgrade in place**. Readiness is checked again before submission.
6. **Follow the outcome.** Open **Migration history** for Workspace, Dataflow name, Request ID, action, outcome, and tracking status. Choose **multiple dataflows...** for the complete list in a right-side panel, or **View API results** for evidence and any returned follow-up actions.
7. **Finish operational validation.** Refresh the upgraded dataflows, review downstream consumers and connector compatibility, and complete Microsoft's applicable follow-ups. A verified Gen2 item is not proof that its first refresh or downstream workloads have succeeded.

Use **Refresh** to reload inventory and reassess. **Reconnect** renews the Microsoft account/consent session. **Disconnect** clears this app's account cache without signing you out of other Microsoft apps. **Dark mode / Light mode** changes appearance and remembers your preference.

### Understanding readiness

| Readiness | Selection behavior |
| --- | --- |
| `ReadyToMigrate` | Included by workspace/group selection; individually selectable. |
| `NeedsAttention` | Individually selectable only; requires acknowledgment of the returned reasons. |
| `UpgradeUnavailable` | Not selectable until the blocking condition is resolved. |
| Not assessed, failed assessment, or unknown/future verdict | Not treated as ready; historical readiness does not unlock the current inventory. |

These are Microsoft's API verdicts, not an application-generated risk score.

## Prerequisites

| Requirement | What you need |
| --- | --- |
| **Fabric hosting workspace** | A capacity-backed workspace where you can deploy a Fabric data app/AppBackend. A tenant administrator must enable the relevant Fabric Apps workload for your scope. See [Rayfin prerequisites][rayfin-app]. |
| **Source dataflows** | Gen1 dataflows in Fabric-capacity-backed workspaces. Microsoft's upgrade prerequisites require Admin, Member, or Contributor workspace access and ownership of each source dataflow. Item creation must be allowed for the relevant scope. See the [upgrade guide][upgrade-guide]. |
| **Application access** | Users need **Run and interact / Read and execute** permission on the deployed Fabric data app. Deployment owners need permission to update its services and schema. |
| **Microsoft Entra registration** | A single-tenant **Single-page application (SPA)** registration, redirect URIs, and the delegated permissions listed below. Someone must be able to register the app and arrange consent under your tenant's policy. |
| **Developer workstation** | Node.js 22 or 24 LTS, npm, and access to the project. Rayfin CLI is included in the repository's development dependencies. The local-frontend/deployed-backend workflow below does not require Docker. |
| **Browser** | A modern browser that permits the app's Microsoft sign-in popup. |

Inventory visibility alone does not establish ownership or upgrade authorization. Microsoft enforces access and availability for each assessment/upgrade request.

## Setup & deployment

### 1. Register the application in Microsoft Entra ID

In **Microsoft Entra admin center > App registrations > New registration**:

1. Name the registration **Dataflow Migration Studio**.
2. Choose **Accounts in this organizational directory only**.
3. Choose **Register**, then open the registration's **Overview** page and copy these values:

   | Entra Overview field | Frontend setting |
   | --- | --- |
   | **Directory (tenant) ID** | `VITE_ENTRA_TENANT_ID` |
   | **Application (client) ID** (the app ID) | `VITE_ENTRA_CLIENT_ID` |

   Do not use the registration's **Object ID**, a workspace ID, or a client secret for either setting. To configure an existing registration, select it under **App registrations > All applications**, then use the same Overview, Authentication, and API permissions pages below.

4. Under **Authentication > Add a platform > Single-page application**, add the callbacks you will use:

   | Environment | SPA redirect URI |
   | --- | --- |
   | Local development | `http://localhost:5173/redirect.html` |
   | Fabric-hosted app | `https://<your-app-host>/redirect.html` |

   Add the hosted callback after the first deployment gives you the hosting URL. The scheme, hostname, port, and path must match the app's actual address. Register `127.0.0.1` separately if you use it instead of `localhost`.

5. Under **API permissions > Add a permission > Power BI Service > Delegated permissions**, add:

   | Permission | Used for |
   | --- | --- |
   | `Workspace.Read.All` | Discover workspaces accessible to the signed-in user. |
   | `Dataflow.Read.All` | Read workspace dataflow inventory. |
   | `Pipeline.Read.All` | Discover visible deployment pipeline stages. |
   | `Dataflow.ReadWrite.All` | Perform reviewed dataflow upgrade actions. |
   | `Item.Execute.All` | Establish authenticated Rayfin execution under that user. |

6. Arrange user/admin consent as required by your organization. If tenant-wide administrator approval is required, have an authorized administrator choose **Grant admin consent for \<your tenant\>** on the **API permissions** page and confirm the grant. Otherwise, users can consent during sign-in only where tenant policy permits it. Declaring permissions on the registration is not itself a consent grant.

**No SPA client secret is needed.** This is delegated user authentication, not an unattended service-principal migration. Use the **Single-page application** platform, not **Web**; the MSAL authorization-code flow with PKCE does not require enabling implicit grant or public-client flows. Tenant and client IDs are public frontend configuration, but Microsoft access tokens and the backend delegation private key are not.

References: [register an Entra application][entra-registration] and [configure redirect URIs][entra-redirect].

### 2. Install dependencies and configure the frontend

Run these commands from the project root in PowerShell:

```powershell
npm ci
npm --prefix .\rayfin\functions ci
Copy-Item .env.example .env.production.local
```

Edit `.env.production.local` in the project root (next to `package.json`) and supply the two registration identifiers copied from Entra Overview:

```dotenv
VITE_ENTRA_TENANT_ID=<directory-tenant-id>
VITE_ENTRA_CLIENT_ID=<application-client-id>
```

Replace the placeholders, including the angle brackets, with your own registration's GUIDs. Both settings are required.

| File in the project root | Purpose |
| --- | --- |
| `.env.example` | Blank template; editing this file alone does not configure the app. |
| `.env.local` | Local development settings used by `npm run dev`. |
| `.env.production.local` | Production settings used by `npm run build` and Rayfin's frontend build. These override matching `.env.local` settings during production builds. |

The app reads these settings in `src\tenantAuth.ts`; do not hardcode IDs in the TypeScript source or generated `dist` files. Vite embeds `VITE_` values at build time: restart the development server after editing `.env.local`, or rebuild and redeploy the frontend after editing `.env.production.local`. Changing a file without rebuilding does not update an already deployed app.

The hosted app obtains its backend URL and publishable key from Rayfin's runtime `rayfin.config.json`; do not hardcode another environment's backend into the production bundle. Keep environment files out of source control.

**Previously saved connections take precedence.** The app checks browser local storage before the environment defaults and saves the registration settings after a successful sign-in. If the browser still uses old IDs after a configuration change, choose **Disconnect**, open browser developer tools for the app's origin, and remove only the Local Storage entry `dfg2-migration-studio:entra-config:v1`. Reload the app, then choose **Connect tenant** and sign in again. Disconnect alone does not remove that saved configuration. Registration IDs are deployment settings, not editable fields in the current connection dialog.

### 3. Deploy the Fabric data app

Review `rayfin\rayfin.yml`. It enables static hosting, Fabric authentication with external Entra exchange, authenticated functions, MSSQL-backed data, and the managed delegation secret declaration.

```powershell
$workspaceId = "<your-Fabric-workspace-id>"
npx rayfin login
npx rayfin up --workspace-id $workspaceId --item-name "Dataflow Migration Studio"
```

The CLI provisions/updates the AppBackend, services, schema, functions, and frontend. Record the hosting URL and backend connection information emitted by your deployment. CLI sign-in is separate from the end user's Microsoft popup; the app does not inherit your Azure CLI session.

### 4. Provision the server-only delegation key

After the first deployment, generate an RSA private key and pipe its base64-encoded PKCS8 PEM directly to Rayfin's managed secret store:

```powershell
node --input-type=module -e "import {generateKeyPairSync} from 'node:crypto'; const {privateKey}=generateKeyPairSync('rsa',{modulusLength:3072}); process.stdout.write(Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'));" | npx rayfin secret set USER_DELEGATION_PRIVATE_KEY --stdin
npx rayfin secret list
```

Generate this key once per environment. Repeating the generation command rotates it; reconnect open app sessions afterward. Never add the private key to a `VITE_` variable, the README, source code, or logs. `secret list` lists names and metadata, not secret values. See [Rayfin secret management][rayfin-secrets].

### 5. Finish redirect configuration and publish

- Add `https://<your-app-host>/redirect.html` to the Entra registration's **SPA** redirect URIs.
- Add the hosted **origin** (`https://<your-app-host>`, without `/redirect.html`) to `services.auth.allowedRedirectUris` in `rayfin\rayfin.yml`. Preserve the existing configuration and any origins still used by your deployments.
- Keep `services.auth.fabric.externalEntraExchange: true` and `services.functions.auth.type: application` enabled.

Synchronize the final configuration:

```powershell
npx rayfin up --workspace-id $workspaceId --item-name "Dataflow Migration Studio"
npx rayfin up status
```

Grant intended users **Read and execute / Run and interact** access to the Fabric data app. Open the hosted app and complete the [quick how-to](#quick-how-to). Hosting the frontend alone is not enough: the authenticated backend, SQL audit schema, delegation secret, registration, and consent must all be configured.

### Updating an existing deployment

For UI-only changes, deploy just the static app. For execution-code changes, deploy functions too. Apply schema/configuration changes through the full `rayfin up` workflow.

```powershell
npx rayfin up staticapp deploy
# Only when backend function code changes:
npx rayfin up functions deploy
```

Scoped deployments use the active Rayfin target. Preserve its managed key and authentication settings; a normal UI update does not require generating another key.

## Local development

Use a local frontend with your deployed authenticated Rayfin backend:

```powershell
Copy-Item .env.example .env.local
```

Fill in the registration IDs and uncomment/set the backend connection values in `.env.local`:

```dotenv
VITE_ENTRA_TENANT_ID=<directory-tenant-id>
VITE_ENTRA_CLIENT_ID=<application-client-id>
VITE_RAYFIN_API_URL=<your-deployed-Rayfin-backend-API-URL>
VITE_RAYFIN_PUBLISHABLE_KEY=<your-backend-publishable-key>
```

Register `http://localhost:5173/redirect.html` as an Entra SPA callback and retain `http://localhost:5173` in Rayfin's allowed origins. Then run:

```powershell
npm run dev -- --port 5173 --strictPort
```

Open `http://localhost:5173`. Restart Vite after changing environment values. This command serves the frontend only; it does not provision the backend or run migrations. With no valid configuration/sign-in, the app stays blank rather than substituting demo data.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `AADSTS50011` | Compare the callback in the sign-in error with the Entra **SPA** redirect URI. Include `/redirect.html`; check protocol, hostname, and port. |
| Sign-in popup times out or is blocked | Allow popups, close abandoned sign-in windows, and choose **Reconnect**. Keep the passive `redirect.html` callback script-free and do not add Cross-Origin-Opener-Policy headers or a redirect-bridge script. |
| Sign-in is not configured | Set both `VITE_ENTRA_*` values and rebuild. Registration IDs are deployment settings, not editable fields in Connect tenant. |
| Sign-in still uses the previous app or tenant ID | Confirm you edited the correct environment file, restart Vite or rebuild/redeploy, then remove the saved connection entry as described in [frontend configuration](#2-install-dependencies-and-configure-the-frontend). |
| Administrator approval is required | Ask an authorized tenant administrator to review the registration's delegated API permissions and grant consent under your organization's policy, then reconnect. |
| Inventory loads but execution/history fails | Check the backend URL/key, `USER_DELEGATION_PRIVATE_KEY`, authenticated services, `Item.Execute.All` consent, and the user's AppBackend execute permission. Use **Retry live connection** for a temporary backend failure. |
| Workspace cannot be selected | Let the current assessment finish. Group selection needs at least one available `ReadyToMigrate` item. Unresolved upgrades lock their workspace; NeedsAttention items require individual selection. |
| Stage is `Unknown` | The account may not see the relevant deployment pipeline. Pipeline visibility and workspace visibility are separate. |
| Tracking pauses / Needs reconciliation | Read the saved request and API error. **Refresh** retries tracking without submitting another upgrade. Do not treat an unavailable operation result as proof of success. |
| Recent UI update is not visible | Refresh the existing app tab to load the newly deployed assets. |

## How it works

```text
React interface -> Microsoft Entra user sign-in -> Live Power BI inventory
       |
       +-> Rayfin authenticated functions -> Native Microsoft readiness / upgrade APIs
                       |
                       +-> Owner-scoped SQL audit + operation tracking + Gen2 readback
```

Readiness comes from `gen1UpgradeReadinessResults`; reviewed upgrades use `gen1Upgrade`. Functions persist intent before submission and recheck readiness. Batches contain at most 50 selected IDs from one workspace. Accepted operations are polled automatically using GET requests, honoring Retry-After; a reload never resubmits an upgrade.

History belongs to the authenticated user, not the whole tenant. New upgrades retain selected names before submission. Older names are resolved only from saved API evidence or the exact original assessment, never guessed from unrelated inventory. **Export audit** exports the loaded records; use **Load older records** to include earlier history.

If an accepted operation/result returns 404 before its final result was saved, the app can verify the exact original IDs through the typed Gen2 API. All selected IDs must be confirmed before the audit becomes **Reconciled**. This is an application audit state: it does not manufacture the missing Microsoft result or its follow-up actions. Unverified IDs remain unresolved.

<details>
<summary><strong>Implementation notes and important boundaries</strong></summary>

- Microsoft account tokens use MSAL session storage; inventory remains in memory. Only public registration configuration and appearance preferences are stored locally.
- Live execution uses a short-lived, caller/request-bound encrypted delegation envelope. The backend does not migrate as the app owner or silently substitute another identity.
- Cached sessions can restore automatically. Interactive renewal requires **Reconnect** rather than a background popup.
- Only a completed assessment from the current inventory load can enable selection. Filtering, expanding groups, or visiting history does not rerun assessments; Refresh/reload does.
- Running and unresolved upgrade requests lock their workspace. Tracking pauses on errors or after 15 minutes; Refresh retries read-only tracking.
- Microsoft may return unrelated workspace rows as `Skipped / NotSelectedForUpgrade`; the audit retains them, but they are not counted as selected migration failures.
- This UI uses native **in-place upgrades**, not the original accelerator's Gen1-preserving `saveAsNativeArtifact` notebook path. It does not execute downstream rewrites, schedules, or refreshes on your behalf.
- Legacy sample/storage adapters remain for isolated tests only. They are not a demo mode in the live application.

</details>

## Optional synthetic test inventory

The `notebooks` folder includes **Seed Synthetic Dataflow Gen1 Inventory** and **Cleanup Synthetic Dataflow Inventory**, as notebooks and cell-marked Python sources. They are separate utilities, not deployment prerequisites.

Both start with `DRY_RUN = True`. Review target workspaces and the preview before explicitly enabling writes. The seeder creates Gen1 test items and can request real Microsoft assessment verdicts; fixture names never manufacture readiness statuses. Retain its creation-results CSV for cleanup of additional fixtures. The cleanup notebook uses provenance and identity checks and verifies deletion; consult its cells for manifest scope and CSV options.

## Development & validation

```powershell
npm run lint
npm test
npx playwright install chromium
npm run test:e2e -- --workers=1
npm run build
npm --prefix .\rayfin\functions run build
```

Browser tests replace identity/API boundaries and never submit real tenant migrations. Tests cover delegated sign-in, API-only readiness, selection rules, audit evidence, automatic tracking/reconciliation, responsive layout, and persistent neutral-grey dark mode.

| Location | Purpose |
| --- | --- |
| `src\LiveWorkbench.tsx` | Inventory, selection, migration review, history, and result panels. |
| `src\tenantAuth.ts` / `src\tenantInventory.ts` | Microsoft sign-in and live inventory discovery. |
| `src\liveClient.ts` | Rayfin session, encrypted delegation, and function calls. |
| `rayfin\functions\src` | Native assessment/upgrade execution and authenticated audit writes. |
| `rayfin\data` | Typed audit entities and schema. |
| `rayfin\rayfin.yml` | Fabric authentication, services, hosting, and secret declarations. |
| `public\favicon.svg` | Shared purple-flow/lightning icon for the app, browser tab, and this README. |

## References

- [Microsoft Rayfin][rayfin-repo]
- [Rayfin deployment quickstart][rayfin-quickstart] and [Fabric data app prerequisites][rayfin-app]
- [Microsoft Entra app registration][entra-registration] and [SPA redirect URIs][entra-redirect]
- [Microsoft Dataflow Gen1 upgrade guidance][upgrade-guide]
- [Original Fabric Toolbox DFG2 migration accelerator][accelerator]

[rayfin-repo]: https://github.com/microsoft/rayfin
[rayfin-quickstart]: https://microsoft.github.io/rayfin/docs/guide/cli/quickstart/
[rayfin-app]: https://microsoft.github.io/rayfin/docs/guide/app-backend/
[rayfin-secrets]: https://microsoft.github.io/rayfin/docs/guide/cli/secrets/
[entra-registration]: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
[entra-redirect]: https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri
[upgrade-guide]: https://learn.microsoft.com/en-us/fabric/data-factory/migrate-to-dataflow-gen2-using-upgrade-wizard
[accelerator]: https://github.com/microsoft/fabric-toolbox/tree/main/accelerators/DFG2-migration-accelerator
