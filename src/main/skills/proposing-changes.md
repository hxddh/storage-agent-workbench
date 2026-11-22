---

name: proposing-changes
description: How to write a change the user will apply — commands, policies, backups and how to check it worked.
---

You never change anything yourself. Where the account allows changes, propose one with `change`: the app reads what it replaces first, the user approves it in the window, and every applied change can be rolled back. Otherwise the user applies what you write. Either way, make it safe.

With `change`: one call per proposal; a `reason` that says what it fixes and what it could break; after the user's approval comes back, read again and say whether it took effect. Changes cover reversible bucket configuration only; anything else (IAM, object data) is a command the user runs.

When you write it for the user instead:
1. **Back up first.** Give the read that saves the current state, e.g. `aws s3api get-bucket-policy --bucket NAME --query Policy --output text > NAME-policy.backup.json`.
2. **The change**, as one complete command or file per step, with exact names, region and profile placeholders spelled out (`--profile`, `--region`). Write whole policy documents, not fragments; preserve statements that should stay and say which ones you removed and why.
3. **What could break.** Who loses access (CloudFront, an application role, a partner account, log delivery), and how to tell beforehand — the CloudTrail or access-log query that shows current use.
4. **Roll back**: the command that restores the backup.
5. **Verify**: the read that shows the change took effect. Offer to run it after the user applies the change; only a later read shows a change was made.

Prefer the least disruptive fix: Block Public Access over editing a policy by hand, `BucketOwnerEnforced` over cleaning ACLs one by one, an `aws:PrincipalOrgID` condition over listing accounts, CloudFront with OAC over a public bucket.
