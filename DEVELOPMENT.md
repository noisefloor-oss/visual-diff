# Development model

The public repository for this project is a **curated release mirror**, not
a development repository.

- Source is available under the [MIT license](LICENSE).
- Development happens in a private repository. Each public release lands as
  one curated snapshot commit with release notes; private development
  history, review discussions, and internal references are not mirrored.
- **Pull requests are not accepted.** This project is solo-maintained and is
  not seeking contributors, co-maintainers, or a community governance
  structure. Forking under MIT is of course fine, but forks are not an
  upstream contribution path.
- **Issues are open** and are the supported inbound channel for bug reports
  and feedback. Filing an issue creates no commitment to a fix, a timeline,
  or a response SLA — but reports are read and genuinely useful.
- For security reports, see [SECURITY.md](SECURITY.md) — please do not open
  a public issue for a vulnerability.

## AI assistance

This software is developed with heavy, deliberate use of autonomous coding
agents operating under machine-enforced review and release gates, including
a cross-model review requirement on every merge. A human (Doug Doan) directs
the work, owns every release decision, and is responsible for what ships.
Releases are built and verified from an exact, audited candidate commit
before publication, and the test suite includes an archive-hygiene gate run
against the actual release payload.

## Status

Releases are **experimental**: the tool is daily-driven by its author
against real repositories, but interfaces, file formats, and behavior may
change between releases without a deprecation cycle. Compatibility
commitments, where they exist, are stated in the README.
