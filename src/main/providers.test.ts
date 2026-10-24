import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { awsProfiles } from './providers'

describe('AWS profiles', () => {
  it('lists profile names from both shared files, default first, no secrets read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-aws-'))
    const config = join(dir, 'config')
    const credentials = join(dir, 'credentials')
    writeFileSync(
      config,
      '[default]\nregion = us-east-1\n[profile prod-sso]\nsso_session = corp\n[sso-session corp]\nsso_start_url = x\n',
    )
    writeFileSync(credentials, '[legacy]\naws_access_key_id = AKIA\naws_secret_access_key = s\n')
    expect(
      awsProfiles({ AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials }),
    ).toEqual(['default', 'legacy', 'prod-sso'])
  })

  it('returns nothing when the files are missing', () => {
    expect(
      awsProfiles({ AWS_CONFIG_FILE: '/nope/config', AWS_SHARED_CREDENTIALS_FILE: '/nope/c' }),
    ).toEqual([])
  })
})
