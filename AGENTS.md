# Repository Agent Instructions

## Delivery

- The user reviews this application only on the production site. After implementing and validating every requested change, commit only the scoped files, push the current branch to `origin`, deploy that exact revision to the linked Vercel production project, and verify the live deployment before reporting completion.
- Do not stop at a local, unpushed, or preview-only state unless the user explicitly requests otherwise.
- Include the commit SHA and production URL/status in the final handoff. If commit, push, or production deployment is blocked, report the blocker clearly instead of claiming the change is complete.
