# PatchPool

PatchPool coordinates distributed Codex workers to solve, review, and submit
patches for approved open-source projects.

## Why PatchPool?

Open-source projects often have more issues than maintainers and volunteers can
address. At the same time, individual AI coding subscriptions can have unused
capacity. PatchPool aims to put that capacity to work without sharing accounts,
credentials, or local environments.

## Core principles

- Each participant runs a worker on their own computer.
- Each participant authenticates Codex and GitHub locally.
- Authentication credentials never leave the participant's computer.
- Only explicitly approved public repositories are eligible.
- The coordinator assigns each issue to a single worker to avoid duplicate work.
- A different participant's worker reviews a patch before it is submitted for
  human review.
- External contributions are disclosed as AI-assisted.

## Project status

PatchPool is currently in requirements definition and architecture design. The
initial specification will be published before application development begins.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues according
to [SECURITY.md](SECURITY.md), not through public issues.

## License

Licensed under the [Apache License 2.0](LICENSE).
