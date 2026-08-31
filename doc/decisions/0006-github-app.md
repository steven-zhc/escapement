# 0006 — A GitHub App, not a personal access token

**Status** accepted · 2026-08-31

## Context

Escapement needs to read issues, write labels and comments, push branches, open
pull requests and merge. A fine-grained PAT can do all of it.

It can also do it wrong in a way that is hard to see. On 2026-08-30 the admin
repository's CI failed on every run with a 403. The token was present and the
secret was set; the fine-grained PAT simply covered the submodule repository and
not the main one. Nothing in the failure said so.

## Decision

A GitHub App, installed per repository.

| Permission | Level | For |
|---|---|---|
| Issues | read + write | reading work items, writing `agent:*` labels and comments |
| Contents | read + write | cloning, pushing `agent/*`, merging into base |
| Pull requests | read + write | opening and reading PRs |
| Metadata | read | required |
| Webhooks | `issues`, `push` | event-driven discovery, replacing the hourly poll |

## Consequences

- Which repositories are reachable is explicit in the installation, not implicit
  in a token's scope — the exact failure above becomes visible at install time.
- Installation tokens are short-lived; no long-lived credential sits on disk.
- Webhooks come with the App rather than needing separate configuration, which
  is what makes discovery event-driven.
- Setup is heavier than pasting a token: an App must be created, given a private
  key, and installed. Worth it at more than one repository, which is the point
  of the project.
- The App's private key is a real secret. It stays out of the repository and out
  of any managed project's environment.
