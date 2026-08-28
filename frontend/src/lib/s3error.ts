/**
 * The thing people paste into this app.
 *
 * An S3 error body is the signature input here — it is what a person is
 * staring at when they open the app at all — and the thread rendered it as a
 * wall of angle brackets in a grey bubble. A tool that understands object
 * storage should recognise its own domain's objects, the way an IDE assistant
 * recognises a stack trace.
 *
 * Three shapes reach this app, and all three are common:
 *
 *   - the S3 REST body, from a browser or `curl`;
 *   - the JSON shape some gateways and SDKs return;
 *   - botocore's own sentence, which is what a Python traceback pastes.
 *
 * Pure and offline: this runs on a keystroke, before any provider exists, and
 * its result names the session as well as rendering it (`sessionTitle.ts`).
 */

export interface S3Error {
  /** `AccessDenied`, `NoSuchBucket`, … — always present, it is what makes this an error. */
  code: string;
  /** The human sentence, when the body carried one. */
  message: string | null;
  /** Identifiers support will ask for. */
  requestId: string | null;
  hostId: string | null;
  /** What the error was about, when the body says. */
  bucket: string | null;
  key: string | null;
  /** The operation, from botocore's sentence. */
  operation: string | null;
}

const tag = (name: string) =>
  new RegExp(`<${name}>\\s*([^<]{0,512}?)\\s*</${name}>`, "i");

const XML_CODE = tag("Code");
const XML_MESSAGE = tag("Message");
const XML_REQUEST = tag("RequestId");
const XML_HOST = tag("HostId");
const XML_BUCKET = tag("BucketName");
const XML_KEY = tag("Key");
const XML_RESOURCE = tag("Resource");

const JSON_STR = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"]{0,512})"`, "i");
const BOTO = /An error occurred \(([A-Za-z][A-Za-z0-9]{2,40})\) when calling the (\w{2,60}) operation(?:[^:]*)?:\s*(.*)/;

/** A bucket named by an `s3://bucket/key` anywhere in the text. */
const S3_URI = /\bs3:\/\/([a-z0-9][a-z0-9.-]{1,62})(?:\/(\S+))?/i;

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9]{2,40}$/;

function first(text: string, ...res: RegExp[]): string | null {
  for (const re of res) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim() || null;
  }
  return null;
}

/**
 * Parse a pasted error, or null when the text is not one.
 *
 * Deliberately strict about the CODE and lenient about everything else: a code
 * is what makes this an error rather than prose, and every other field is
 * genuinely optional in bodies real providers return.
 */
export function parseS3Error(text: string | null | undefined): S3Error | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const boto = raw.match(BOTO);
  const code =
    first(raw, XML_CODE, JSON_STR("Code")) ?? (boto ? boto[1] : null);
  if (!code || !CODE_SHAPE.test(code)) return null;

  const uri = raw.match(S3_URI);
  const resource = first(raw, XML_RESOURCE);
  // `<Resource>/acme-logs/logs/x.gz</Resource>` is the other place a bucket and
  // key hide, and for some providers it is the only one.
  const fromResource = resource?.replace(/^\//, "").split("/") ?? [];

  return {
    code,
    message:
      first(raw, XML_MESSAGE, JSON_STR("Message")) ?? (boto ? boto[3]?.trim() || null : null),
    requestId: first(raw, XML_REQUEST, JSON_STR("RequestId")),
    hostId: first(raw, XML_HOST, JSON_STR("HostId")),
    bucket:
      first(raw, XML_BUCKET, JSON_STR("BucketName")) ??
      uri?.[1] ??
      (fromResource.length > 1 ? fromResource[0] : null) ??
      null,
    key:
      first(raw, XML_KEY, JSON_STR("Key")) ??
      uri?.[2] ??
      (fromResource.length > 1 ? fromResource.slice(1).join("/") : null) ??
      null,
    operation: boto ? boto[2] : null,
  };
}

/**
 * Is this message essentially JUST the pasted error?
 *
 * A question that quotes an error in passing should stay prose — replacing a
 * paragraph with a card because it mentions `AccessDenied` would be the tool
 * overruling the person. The test is how much of the text the error body
 * accounts for.
 */
export function isMostlyError(text: string, err: S3Error): boolean {
  const body = text.trim();
  if (/^\s*</.test(body) || /^\s*\{/.test(body)) return true;
  // botocore's sentence, alone or with a traceback around it.
  const sentence = err.operation ? body.match(BOTO)?.[0] ?? "" : "";
  return sentence.length >= body.length * 0.6;
}
