# Threadnest staging

Public entry point: [threadnest.patanin.workers.dev](https://threadnest.patanin.workers.dev/).
The Cloudflare Worker proxies the existing AWS EC2 application in Sydney
(`ap-southeast-2`). Docker runs the application and PostgreSQL; persistent data
lives on encrypted EBS storage. The address does not make the AWS host or AI
inference free indefinitely. Nebius Token Factory usage is billed separately.

## Branding

The product name is **Threadnest**. The displayed wordmark is **Threadnest.**
with a lime signature dot; sign-in uses the stacked **Thread / nest.** version.
The **Nest and dot** mark from the supplied brand reference is maintained in
[`frontend/public/favicon.svg`](frontend/public/favicon.svg), shared by the
favicon, navigation, sign-in and assistant avatar.

Repository, package, Docker service, database, cookie, credential-path and
workspace-identity names retain their original `personal-ai` identifiers for
compatibility. Existing user-authored workspace content is not renamed.

## Updating the existing staging host

1. Test and commit the release, then merge it into `main`. Deploy an exact commit,
   using production assets; preview builds use mock APIs and must not be deployed.
2. Verify the AWS project remains on its Free plan and the selected Region is
   `ap-southeast-2`. Reconnect the `personal-ai-workspace` CLI profile if needed.
3. Record the running image and retain it for rollback. Back up application
   configuration and the database privately before an update that runs migrations.
   Never include `.env`, credentials, runtime data or workspace files in an image.
4. Build the application release and replace only the application service using
   the existing Compose project and managed-storage overlay. Preserve database
   volumes, runtime configuration, the protected origin proxy and AI pause policy.
5. Check container health and the public HTTPS URL. Verify sign-in, workspace
   reads, CSRF protection and sign-out without making paid model calls. Check the
   Nest and dot mark, wordmark and keyboard focus after a reload.
6. If acceptance fails, restore the recorded application image and configuration.
   If database migrations changed the schema, inspect rollback compatibility
   before attempting an older image; keep the database backup private.

Keep `APP_ORIGIN` set to the Worker URL. Store its origin token only in the
private host configuration and Cloudflare `ORIGIN_TOKEN` secret. Do not print
tokens, owner passwords or AI keys in deployment logs.

The old IP-only HTTPS bootstrap helper does not understand the current protected
origin and redirect configuration. Do not rerun it over the working setup.
CloudFront is not serving this staging address.
