# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in Rekono, please report it privately
rather than opening a public issue -- this repo handles financial data, so
a public report gives an attacker a head start before a fix ships.

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/winnersfrown/Rekono/security/advisories/new)
and click "Report a vulnerability." Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce it (a minimal example, if you have one).
- Any relevant logs, screenshots, or proof-of-concept code.

We'll acknowledge your report within 3 business days and aim to ship a fix
or mitigation within 30 days for confirmed issues, sooner for anything
critical. We'll credit you in the fix's changelog entry unless you'd rather
stay anonymous.

## Supported versions

Rekono ships continuously from `main` -- there's no maintained branch other
than the latest release. Fixes land in the next version, not backported.
