/**
 * The account-wide reading: the S3 Control public access block, which applies
 * to every bucket of the account and can cancel exposure a bucket's own
 * configuration shows. The account id is needed to ask and is never stored,
 * shown or sent to the model.
 */
import { GetPublicAccessBlockCommand, type S3ControlClient } from '@aws-sdk/client-s3-control'
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts'
import type { Dim, PublicAccessBlock } from './facts'
import { classify, isAbort, type ReadStatus } from './status'

export interface AccountFacts {
  pab: Dim<PublicAccessBlock>
}

export const UNREAD_ACCOUNT: AccountFacts = { pab: { status: 'unread', value: null } }

export async function readAccount(
  sts: STSClient,
  control: S3ControlClient,
  signal?: AbortSignal,
): Promise<AccountFacts> {
  let accountId: string | undefined
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal })
    accountId = identity.Account
  } catch (error) {
    if (isAbort(error)) throw error
    return { pab: { status: classify(error), value: null } }
  }
  if (!accountId) return { pab: { status: 'error', value: null } }
  try {
    const response = await control.send(new GetPublicAccessBlockCommand({ AccountId: accountId }), {
      abortSignal: signal,
    })
    const cfg = response.PublicAccessBlockConfiguration
    if (!cfg) return { pab: { status: 'not_configured', value: null } }
    return {
      pab: {
        status: 'available',
        value: {
          blockPublicAcls: Boolean(cfg.BlockPublicAcls),
          ignorePublicAcls: Boolean(cfg.IgnorePublicAcls),
          blockPublicPolicy: Boolean(cfg.BlockPublicPolicy),
          restrictPublicBuckets: Boolean(cfg.RestrictPublicBuckets),
        },
      },
    }
  } catch (error) {
    if (isAbort(error)) throw error
    const name = (error as { name?: string })?.name
    const status: ReadStatus =
      name === 'NoSuchPublicAccessBlockConfiguration' ? 'not_configured' : classify(error)
    return { pab: { status, value: null } }
  }
}

/** The account posture worth remembering: statuses and booleans only. */
export function rememberAccount(facts: AccountFacts): Record<string, unknown> {
  return {
    account_pab_status: facts.pab.status,
    ...(facts.pab.value ? { account_pab: facts.pab.value } : {}),
  }
}
