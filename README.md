# Release Flow

A GitHub Action that automates releases for repositories with a staging branch (default `dev`) and a production branch (default `main`):

- **Push to staging** (`prepare`): opens or updates a `Deploy to production` pull request from staging to main. Its body lists the projected version, the aggregated changelog and the pull requests included.
- **Push to main** (`finalize`): creates a GitHub release `vX.Y.Z` for the merged changes, with the aggregated changelog as release notes.

The changelog comes from a `Changelog Entry` section in each pull request body, and the version bump is computed from it. The action only talks to the GitHub API and never reads the working tree, so you do not need `actions/checkout`.

## Usage

```yaml
name: Release

on:
  push:
    branches: [dev, main]

permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write

      - uses: potatowski/release-flow@v1
        with:
          github_token: ${{ steps.app-token.outputs.token }}
```

The phase is detected from the pushed branch. Pushes to any other ref are logged and the action exits successfully. When `phase: finalize` is forced from another ref, the current head of the main branch is released.

**Merge the deploy pull request with a merge commit.** Squash or rebase merges rewrite the staging commits on main, so staging and main stop sharing a merge base and later deploy pull requests show already-released changes again. The action still finds the right pull requests for that release (it reads the deploy pull request's own commits) and logs a warning.

If an open staging-to-main pull request already exists and was not created by this action (its body has no `<!-- release-flow:deploy -->` marker), it is left untouched and a warning is logged.

### GitHub App setup

1. Create a GitHub App on your personal account (**Settings > Developer settings > GitHub Apps > New GitHub App**).
   - Disable the webhook (uncheck **Active**). No callback URL is needed.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**. Metadata (read-only) is selected automatically.
2. Generate a private key and note the App's Client ID.
3. Install the App on the repositories that will use this action.
4. In each repository (or at the account level), add:
   - a variable `RELEASE_APP_CLIENT_ID` with the Client ID;
   - a secret `RELEASE_APP_PRIVATE_KEY` with the contents of the private key file.

Caveat: with `update_major_tag: true`, moving a tag to a commit that changes files under `.github/workflows` may be rejected unless the App also has the **Workflows: Read and write** permission (add `permission-workflows: write` to the token step as well).

### Why an App token

Events created with the workflow's built-in `GITHUB_TOKEN` do not trigger new workflow runs. A deploy pull request opened with `GITHUB_TOKEN` would not run your CI checks, so branch protection would block it. A token from a GitHub App acts as a separate identity, so the pull requests and releases it creates trigger workflows normally.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `github_token` | yes | | Token used for API calls. Use a GitHub App token. |
| `staging_branch` | no | `dev` | Staging branch name. |
| `main_branch` | no | `main` | Production branch name. |
| `phase` | no | | Force `prepare` or `finalize`. Auto-detected from `github.ref` when empty. |
| `update_major_tag` | no | `false` | When `true`, `finalize` also moves the major tag (for example `v1`) to the released commit. Re-runs move it too when the release already exists. |
| `since` | no | | Tag or commit SHA where the first release range starts when no `vX.Y.Z` tag exists yet. |

## Outputs

| Name | Description |
| --- | --- |
| `next_version` | Computed version, for example `v1.4.0`. Empty when there is nothing to release. |
| `release_body` | The deploy pull request body (`prepare`) or the release notes (`finalize`). |

## Changelog format

Add this section to your pull request template:

```markdown
## 📋 Changelog Entry

### Added
-
### Changed
-
### Deprecated
-
### Removed
-
### Fixed
-
### Security
-
```

Parsing rules:

- The block starts at the first level-2 heading whose text contains `Changelog Entry` (case-insensitive; emoji and extra words are fine) and ends at the next level-2 heading or the end of the body.
- Recognised sections are `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` and `Security` (case-insensitive). Other sections are ignored.
- Items are bullets starting with `-` or `*`. Empty bullets and placeholders (`-`, `N/A`, `none`, `TBD`, case-insensitive, trailing punctuation ignored) are skipped. HTML comments are ignored.
- Lines indented by two or more spaces (or a tab) right after a bullet, including nested bullets, are appended to it, so an item can span several lines.
- In the rendered bodies, `@mentions` are wrapped in backticks and `<` is escaped, so pull request text cannot ping people or inject HTML.

A pull request is a **breaking change** when any of these holds (HTML comments and fenced code blocks are ignored):

- a `**Breaking Change:**` line answers `Yes` (a literal `(Yes/No)` hint is ignored, and a line that also says `No` does not count);
- a line starts with `BREAKING CHANGE:` or `BREAKING-CHANGE:`;
- the title uses the Conventional Commits `!` marker (for example `feat(api)!: drop v1`).

## Which pull requests are included

Merged pull requests targeting the staging or main branch whose merge commit is in the range:

- `prepare`: commits on staging that are not on main (`main...staging`).
- `finalize`: commits between the latest version tag and the pushed commit. If the pushed commit comes from a squash or rebase merged deploy pull request, that pull request's commits are used instead.

**First release.** When no `vX.Y.Z` tag exists, the range starts at the `since` input if set; otherwise all commits reachable from the pushed commit are scanned (up to 2000), so every merged pull request with a changelog entry in the history lands in the first release. The first version is bumped from `0.0.0`.

Pull requests whose head branch is the staging or main branch of this repository (deploy pull requests and back-merges) are excluded. Pull requests from forks are kept even if their branch has the same name.

Closed pull requests are scanned most recently updated first (up to 10 pages of 100 per base branch). The scan stops once all commits in the range are matched or pull requests were last updated before the oldest commit in the range. A warning is logged if the page limit is reached.

## Version bump rules

The current version is the highest `vX.Y.Z` among published release tags (drafts and prereleases are ignored) and repository tags. With no such tag, the current version is `0.0.0`.

| Condition | Bump |
| --- | --- |
| Any breaking change | major (minor while the major version is `0`) |
| Any `Added` entry | minor |
| Any other entry | patch |
| No entries | nothing to release |

`finalize` is idempotent: if a release with the computed tag already exists, it exits without creating anything. If the tag exists without a release, the release is created when the tag points at the pushed commit; if the tag points at another commit, the action fails instead of publishing a release for the wrong code.

## Development

```sh
npm ci
npm test        # node:test unit tests
npm run build   # bundles src/ into dist/index.cjs with @vercel/ncc
```

`dist/` is committed because GitHub runs the bundled file directly. Run `npm run build` and commit the result after changing anything in `src/`; CI fails when `dist/` is out of date.

Source layout:

- `src/changelog.cjs`: changelog parsing, aggregation and rendering (pure).
- `src/version.cjs`: semver parsing and bump rules (pure).
- `src/github.cjs`: GitHub API helpers that take an Octokit instance.
- `src/phases.cjs`: `prepare` and `finalize` orchestration with injected Octokit and context.
- `src/index.cjs`: action entry point.

## License

[MIT](LICENSE)
