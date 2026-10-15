# 0011. Ship signed worker releases and update with our own verifier

- Status: Accepted (supersedes the `go-selfupdate` entry in decisions.md)
- Date: 2026-10-12
- Deciders: maintainers

## Context

Installing the worker with `go install` required Go 1.27 on every machine and reported version `0.0.0-dev`, so the hub
could not tell outdated machines. A binary that updates itself must not install a tampered build (SRS FLEET-02,
FLEET-05, FLEET-06, NFR-04).

## Decision

Tag `v*` triggers goreleaser: six archives, `checksums.txt` signed with ECDSA P-256 (key in the repository secret
`WORKER_SIGNING_KEY`, public key in `worker/internal/update/release-signing.pem` and both install scripts), a draft
release that is verified and attested before it is published. `install.sh`, `install.ps1` and `hive-worker update`
verify the signature and SHA-256 before installing. The updater is `worker/internal/update`, written with the Go
standard library. The hub shows outdated machines and can ask a worker to update after its current runs.

## Consequences

- Good: no toolchain on user machines; tampered releases are refused; updates never interrupt runs when triggered
  from the hub.
- Bad: rotating the signing key requires reinstalling workers with the new key.

## Alternatives considered

- `creativeprojects/go-selfupdate`: alone it added about 8 MB and over 15 modules (including GitLab and Gitea SDKs) to
  an 8 MB binary.
- Sigstore keyless signing: verification in Go and PowerShell 5.1 would need much larger dependencies.

## Links

- PR #85, #86; [releasing.md](../releasing.md)
