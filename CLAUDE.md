# Working in this repo

## Version numbering

Releases are numbered `1.0`, `1.1`, `1.2`, … in order. `v1.0` is the
baseline recorded in `CHANGELOG.md`; every merged change after it takes the
next number.

Two things to do for each one:

1. **Prefix the commit subject with the version**, e.g.
   `v1.2: Add a bulk re-run action to the review queue`. One merged change
   is one version, so `git log --oneline` on `main` reads as the release
   history.
2. **Add a `CHANGELOG.md` entry** under a `## v1.2` heading saying what
   changed and why, in the same voice as the existing entries.

To find the next number, read the top entry in `CHANGELOG.md` (do not guess
from memory -- the container is rebuilt between sessions and `main` may have
moved).

Annotated git tags would be the more conventional way to do this, but
pushing `refs/tags/*` is blocked by the git proxy in the Claude Code
sandbox, so the number lives in the commit subject and the changelog
instead. If you're working outside that sandbox, tagging as well is welcome
-- just keep the changelog as the source of truth.

## Tests

`cd backend && npm test` runs the suite against SQLite. That is the gate.

A second mode runs the same suite against Postgres with row-level security
live, which is the only way to exercise the policies (SQLite has no
equivalent feature):

```bash
cd backend
./scripts/setup-test-postgres.sh
REKONO_TEST_PG_URL=postgres://rekono_app:apppw@127.0.0.1:5432 npm test
```

`tests/rls.test.js` passes reliably there. The rest of the suite in that
mode is still flaky -- tests don't await their own uploads, so a background
job can be mid-write when the next test resets. See README.md's "Row-level
security" section.
