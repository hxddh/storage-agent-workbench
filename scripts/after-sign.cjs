/**
 * electron-builder afterPack hook.
 *
 * Without a Developer ID certificate electron-builder leaves the .app unsigned;
 * on Apple silicon that reads as "damaged" after download. An ad-hoc signature
 * is not a trust identity, but it lets the app launch and keeps the limitation
 * explicit in the release notes. A real certificate or auto-discovery skips it.
 * This runs after packing and before electron-builder's own signing step; it
 * must not run from afterSign, which electron-builder skips when nothing was
 * signed.
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(app)) return
  console.log(`ad-hoc signing ${app}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
