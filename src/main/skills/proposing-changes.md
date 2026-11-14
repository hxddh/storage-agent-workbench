---

name: proposing-changes
description: How to write a change the user will apply — commands, policies, backups and how to check it worked.
---

You cannot change anything; the user applies what you write. Make it safe to paste.
1. **Back up first.** Give the read that saves the current state, e.g. `aws s3api get-bucket-policy --bucket NAME --query Policy --output text > NAME-policy.backup.json`.
2. **The change**, as one complete command or file per step, with exact names, region and profile placeholders spelled out (`--profile`, `--region`). Write whole policy documents, not fragments; preserve statements that should stay and say which ones you removed and why.
3. **What could break.** Who loses access (CloudFront, an application role, a partner account, log delivery), and how to tell beforehand — the CloudTrail or access-log query that shows current use.
4. **Roll back**: the command that restores the backup.
5. **Verify**: the read that shows the change took effect. Offer to run it after the user applies the change; only a later read shows a change was made.

Prefer the least disruptive fix: Block Public Access over editing a policy by hand, `BucketOwnerEnforced` over cleaning ACLs one by one, an `aws:PrincipalOrgID` condition over listing accounts, CloudFront with OAC over a public bucket.
