# S3-compatible endpoints

An account is a name, an endpoint, a region, path-style addressing, keys or an
AWS profile, and an optional bucket scope. An empty endpoint means AWS. The app
does not classify accounts by provider and keeps no list of what a provider
supports.

## Where calls go

- **Custom endpoint.** Every call of the account goes to its endpoint, for
  every bundled service: S3, S3 Control, STS, IAM, Organizations, KMS, Access
  Analyzer, CloudWatch and CloudTrail. The credentials are never sent to AWS.
  S3 Control uses the endpoint as given, not an account-prefixed host name.
  Turn on path-style addressing for an endpoint that does not answer
  virtual-hosted bucket names.
- **AWS.** Each service goes to its AWS endpoint in the region the agent names
  or the account's region. IAM and Organizations use `us-east-1`. S3 follows
  region redirects, so buckets in other regions read from their own region.

## What an endpoint does not implement

`call` sends every read it is asked for. An endpoint that does not implement
an operation, or a whole service, answers with its own error, for example
`NotImplemented (HTTP 501)`, a 405 or a 404. The agent receives that error
with its code, HTTP status and message, the step shows it, and the agent says
what it could not read. Nothing is skipped in advance and nothing is
simulated.

An emulator such as moto or LocalStack answers the other services as well; a
storage-only endpoint answers them with errors. Without CloudWatch, `query`
can measure listed objects instead, and the agent should say it measured a
listing.

`probe` shows how the endpoint itself answers: addresses, status, headers and
TLS certificate.

See [iam.md](iam.md) for AWS permissions and [tools.md](tools.md) for `call`.
