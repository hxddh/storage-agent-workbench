---

name: identities-and-keys
description: Which IAM users, roles and access keys can reach storage, which keys are stale, and what a principal is actually allowed to do.
---

## Inventory

- `iam GetAccountAuthorizationDetails` returns users, groups, roles and policies with their documents in one paged call (`Marker`). Use `query` to page and reduce it.
- `iam ListUsers`, `ListAccessKeys {UserName}` (key ids, status, created), `GetAccessKeyLastUsed {AccessKeyId}` (last used date, service, region). Access key ids are identifiers, not secrets; you see them whole.
- `iam GetAccountSummary`, `GetAccountPasswordPolicy`, `ListMFADevices {UserName}`, `GetLoginProfile {UserName}` (console access).
- Roles: `GetRole` includes `RoleLastUsed`.
- The credential report needs `GenerateCredentialReport`, which writes; you cannot create it. If one exists, `GetCredentialReport` returns it (base64 CSV in `Content`) — import with `dataset`.

## Stale or risky keys

Active keys never used, or unused for 90+ days; users with two active keys; keys older than a rotation period the user names; console users without MFA. Compute ages in a `query` from the dates; give the reference date.

## Effective permissions

Identity policies alone do not decide access. The whole chain: SCPs (`organizations ListPoliciesForTarget`, `DescribePolicy`), permission boundaries, identity policies, resource policy (bucket, access point, KMS key), session policies. `iam SimulatePrincipalPolicy {PolicySourceArn, ActionNames, ResourceArns}` evaluates identity policies, boundaries and (optionally) a resource policy you pass in `ResourcePolicy`; it does not include SCPs unless you add them by hand. Say which parts you evaluated.

## A good answer

Name the principals with access to the storage asked about, how (which statement), and which keys to rotate or disable first, with a CLI command per change for the user to run.
