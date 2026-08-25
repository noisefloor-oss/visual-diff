# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub Security Advisories**
("Report a vulnerability" under the public repository's Security tab). Do
not open a public issue for a security problem.

Reports are read by the maintainer. This is an experimental, solo-maintained
project: there is no response-time SLA and no bug bounty, but genuine
vulnerabilities are taken seriously and fixes are prioritized over feature
work.

## Scope

This tool treats imported design zips, comp HTML, and their declared
external dependencies as **untrusted input**: extraction is hardened against
path traversal, symlinks, and decompression bombs; renders run under network
isolation with vendored dependencies verified by hash; artifacts carry
provenance records whose content hashes let a third party verify artifact
integrity and renderer-compatibility claims against the retained inputs
(the records also carry observational assertions — browser build, fonts,
readiness path — that are recorded, not independently re-derivable from
the artifact set alone). Reports about breaking
any of those boundaries are exactly what this policy is for. Reports that
require an already-compromised host are still welcome but may be classified
as hardening suggestions rather than vulnerabilities.

## Supported versions

Only the latest tagged release is supported. There are no security backports
to earlier releases.
