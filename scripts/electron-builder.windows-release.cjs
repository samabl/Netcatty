'use strict';

/**
 * Fork-only electron-builder entry point for the Windows release pipeline.
 *
 * It re-exports the upstream `electron-builder.config.cjs` unchanged and only
 * layers Azure Trusted Signing options on top. It lives under scripts/ because
 * the repository root is git-ignored except for an explicit whitelist, and
 * keeping signing here means the upstream config file stays untouched and
 * cannot conflict on every upstream sync.
 *
 * Signing paths supported by the workflow:
 *   - PFX / certificate file: electron-builder reads WIN_CSC_LINK and
 *     WIN_CSC_KEY_PASSWORD by itself; nothing is needed here.
 *   - Azure Trusted Signing: needs win.azureSignOptions, injected below.
 *     Authentication uses EnvironmentCredential, i.e. AZURE_TENANT_ID,
 *     AZURE_CLIENT_ID and AZURE_CLIENT_SECRET on the runner.
 *
 * With neither configured the export is the upstream config object, so an
 * unsigned local/fork build behaves exactly as before.
 */

const base = require('../electron-builder.config.cjs');

const env = process.env;

function azureSignOptionsFromEnv() {
  const publisherName = env.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME;
  if (!publisherName) return null;

  const required = {
    AZURE_TRUSTED_SIGNING_ENDPOINT: env.AZURE_TRUSTED_SIGNING_ENDPOINT,
    AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
    AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      'Azure Trusted Signing is partially configured; missing: ' + missing.join(', '),
    );
  }

  return {
    publisherName,
    endpoint: required.AZURE_TRUSTED_SIGNING_ENDPOINT,
    codeSigningAccountName: required.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
    certificateProfileName: required.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
    // Trusted Signing only accepts SHA256 digests.
    fileDigest: 'SHA256',
    timestampRfc3161: env.AZURE_TRUSTED_SIGNING_TIMESTAMP_URL || 'http://timestamp.acs.microsoft.com',
    timestampDigest: 'SHA256',
  };
}

const azureSignOptions = azureSignOptionsFromEnv();

module.exports = azureSignOptions
  ? { ...base, win: { ...base.win, azureSignOptions } }
  : base;
