# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public issues, discussions, or
pull requests.

Use GitHub's private vulnerability reporting feature for this repository. In
your report, include the affected component, reproduction steps, impact, and
any suggested mitigation. Please avoid accessing or modifying data that does
not belong to you.

If private vulnerability reporting is unavailable, contact the repository
maintainer through a trusted private channel and do not attach credentials,
tokens, or private repository contents.

## MVP security boundary

PatchPool is a local worker, not a credential coordinator. GitHub CLI and Codex
authentication remain in their own local tools; PatchPool does not accept an
API key, persist credentials in SQLite, or send credentials to a service. The
worker sanitizes subprocess environments and redacts command output, but a
participant is still responsible for securing their computer and local CLI
credential stores.

Only an explicitly registered canonical `owner/name` public, non-archived
repository is eligible. Issue text is untrusted input. Codex is invoked with a
workspace-write sandbox and is instructed not to read credentials, commit,
push, or create pull requests. The worker performs verification itself and
limits remote writes to a unique branch and a verified Draft PR. A maintainer
must review every AI-assisted change.

Treat any exposure of credentials, tokens, repository secrets, local files,
cross-repository remotes, non-Draft PRs, or bypasses of the explicit
`--publish` guard as a security vulnerability. Include whether the issue was
reproducible on Windows, Ubuntu, or both.
