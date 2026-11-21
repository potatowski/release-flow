# Privacy Policy

_Last updated: November 21, 2026_

This policy covers the **Changelog Release Flow** GitHub App, the **Release Flow** GitHub Action (`potatowski/release-flow`) and the token broker they use (`release-flow-broker.vitorrocha.workers.dev`). Together they are called "the service" below. The service is maintained by Vitor Rocha ("we").

## What the service accesses

The app asks for these repository permissions:

- **Contents: read and write.** Used to read tags, commits and releases, and to create releases and tags.
- **Pull requests: read and write.** Used to read merged pull requests and their bodies, and to create or update the "Deploy to production" pull request.
- **Metadata: read-only.** GitHub grants this to every app.

The service only acts on repositories where you installed the app, and only while a workflow run that uses the action is running.

## What we store

**Nothing.** The service has no database. It does not keep your code, pull request content, changelogs or release notes. All processing happens in your own GitHub Actions run, and the results are written back to your repository on GitHub.

The token broker gets the workflow's OIDC token. It checks the token, finds the app installation for that repository and returns an installation token that:

- works only on the repository running the workflow;
- has only Contents and Pull requests write access;
- is revoked when the run ends.

The broker does not store OIDC tokens or installation tokens.

## Logs

The token broker runs on Cloudflare Workers. Cloudflare may keep short-lived request logs (such as IP address, timestamp and request path) to run and protect its platform, under the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/). We do not use these logs to track or profile users.

The output of your workflow runs stays in GitHub Actions, under your repository's settings and the [GitHub Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## GitHub Marketplace

When you install, change or cancel the app through GitHub Marketplace, GitHub sends us a webhook event. It contains the account login, account type and plan. We use it only to confirm the event was received. We do not store it, sell it or share it.

## Third parties

- **GitHub** hosts your repositories, the app and the workflow runs.
- **Cloudflare** hosts the token broker.

We do not sell or share data with anyone else.

## Your choices

You can stop all access at any time by uninstalling the app from your account or organization settings: **Settings → Applications → Installed GitHub Apps**. If you use your own GitHub App with the action (`github_token` input), the token broker is never called.

## Changes

If this policy changes, we will update this file and the date at the top.

## Contact

Questions: **contato@vitorrocha.dev**, or open an issue at <https://github.com/potatowski/release-flow/issues>.
