/**
 * electron-builder afterPack hook: re-apply a proper deep ad-hoc signature
 * over electron-builder's output. Without this the binaries are tagged
 * `(adhoc,linker-signed)` which modern macOS Gatekeeper often rejects with
 * "is damaged" even though it's technically signed.
 *
 * `codesign --deep --force --sign -` recursively signs the .app bundle and
 * all its helpers/frameworks with an ad-hoc identity, producing a clean
 * `(adhoc)` flag. This is the strongest signature available without an
 * Apple Developer Program subscription ($99/yr).
 *
 * NOTE: Even a clean ad-hoc signature may not be sufficient on the very
 * latest macOS versions (Sequoia/Tahoe sometimes require notarization).
 * If "is damaged" persists, the user must run:
 *   xattr -dr com.apple.quarantine /Applications/nom.app
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[sign-adhoc] re-signing ${appPath}`);
  execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' });

  // Verify
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
  console.log('[sign-adhoc] verified deep ad-hoc signature');
};
