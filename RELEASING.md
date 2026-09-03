# 📦 DriveDB Releasing & Publishing Guide

This document outlines the standard procedure for releasing new versions of the package (or your own custom fork) from a local development machine.

---

## 🔑 1. Prerequisites

Before publishing, ensure you are logged into an npm account with publishing rights for the package scope:

```bash
npm whoami
# Should output your npm username
```

If not logged in, authenticate using your web browser or command line:

```bash
npm login
```

---

## 🛡️ 2. Automated Safety Checks (`prepublishOnly`)

You do not need to manually worry about shipping broken or untested code. The `package.json` file is configured with:

```json
"prepublishOnly": "npm run typecheck && npm run test && npm run build"
```

Whenever `npm publish` is executed, npm automatically runs:
1. **`tsc --noEmit`**: Verifies zero TypeScript errors.
2. **`vitest run --coverage`**: Runs all 31 unit & integration tests and verifies the strict 92% code coverage threshold.
3. **`tsup`**: Bundles clean, minified ESM (`.mjs`), CJS (`.js`), and type definitions (`.d.ts`).

If **any check fails**, npm will abort the publish immediately and nothing is uploaded.

---

## 🚀 3. Release Commands

### A. Publishing the Initial Release (`0.1.0`)
To publish the existing `0.1.0` package for the first time:

```bash
npm publish --access public
```

---

### B. Releasing Subsequent Versions

Follow semantic versioning (`MAJOR.MINOR.PATCH`):

#### 1. Bump Version and Create Git Tag
Run **one** of the following commands based on the nature of your changes:

* **Patch Release** (bug fixes, docs, test enhancements):
  ```bash
  npm version patch
  # Bumps e.g. 0.1.0 -> 0.1.1
  ```

* **Minor Release** (new backward-compatible features):
  ```bash
  npm version minor
  # Bumps e.g. 0.1.0 -> 0.2.0
  ```

* **Major Release** (breaking API changes):
  ```bash
  npm version major
  # Bumps e.g. 0.1.0 -> 1.0.0
  ```

> `npm version` will automatically:
> 1. Update `version` in `package.json` and `package-lock.json`.
> 2. Create a git commit: `v0.1.1`.
> 3. Create a git tag: `v0.1.1`.

#### 2. Publish to npm
```bash
npm publish --access public
```

#### 3. Push Commit and Tag to GitHub
```bash
git push origin main --follow-tags
```

---

## ❓ Troubleshooting

### 1. `E403 Forbidden - Package name too similar`
* **Cause**: Attempting to publish an unscoped package name that collides with an existing package on npm.
* **Fix**: Ensure `package.json` uses a scoped package name (e.g. `"@<your-username>/drivedb"`) and publish with `--access public`.

### 2. `E403 Forbidden - You cannot publish over previously published versions`
* **Cause**: Trying to re-publish a version number that already exists on npm (npm versions are immutable).
* **Fix**: Run `npm version patch` to bump to the next version before publishing.

### 3. Two-Factor Authentication (2FA) / OTP Prompt
* If npm prompts for an OTP during publish, enter the 6-digit code from your authenticator app (Google Authenticator, 1Password, etc.).
