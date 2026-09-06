#!/usr/bin/env node
/**
 * Release helper for the Orange Five extension.
 *
 * Usage: node scripts/release.mjs <version>   (e.g. 2.5.0)
 *
 * Does:
 *   1. Verify the working tree is clean (untracked files are allowed).
 *   2. Bump `version` in manifest.json and package.json.
 *   3. Turn the CHANGELOG [Unreleased] section into a dated [x.y.z] section.
 *   4. Commit ("Release x.y.z") and tag (vX.Y.Z). Does NOT push.
 *
 * Assumes the [Unreleased] section has content worth releasing; run
 * `npm test` beforehand — this script does not run the suite.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail('usage: node scripts/release.mjs <x.y.z>');
}

// 1. Clean tree (staged or modified files would leak into the release commit).
let status;
try {
  status = sh('git status --porcelain --untracked-files=no');
} catch (e) {
  fail('not a git repository (or git unavailable)');
}
if (status) fail(`working tree not clean:\n${status}\nCommit or stash first.`);

// 2. Bump versions.
const manifestPath = 'manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const oldVersion = manifest.version;
if (oldVersion === version) fail(`manifest.json is already ${version}`);
writeFileSync(manifestPath,
  JSON.stringify({ ...manifest, version }, null, 2) + '\n');

const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.version !== oldVersion) {
  fail(`package.json (${pkg.version}) and manifest.json (${oldVersion}) disagree`);
}
writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + '\n');

// 3. CHANGELOG: rename the [Unreleased] heading to a dated [version] one,
//    then insert a fresh empty [Unreleased] above it.
const date = new Date().toISOString().slice(0, 10);
const clPath = 'CHANGELOG.md';
const changelog = readFileSync(clPath, 'utf8');
const header = `## [${version}] — ${date}`;
if (changelog.includes(header)) {
  console.log(`CHANGELOG already has a [${version}] section — leaving it alone.`);
} else {
  if (!changelog.includes('## [Unreleased]')) {
    fail('CHANGELOG.md has no [Unreleased] section to release');
  }
  writeFileSync(clPath, changelog
    .replace('## [Unreleased]', `## [Unreleased]\n\n${header}`)
    .replace(`${header}\n\n## [Unreleased]\n\n\n`, `${header}\n\n`));
}

// 4. Commit + tag.
sh('git add manifest.json package.json CHANGELOG.md');
sh(`git commit -m "Release ${version}"`);
sh(`git tag v${version}`);
console.log(`Released ${oldVersion} → ${version}.`);
console.log(`Done: commit + tag v${version} created locally. Push with:`);
console.log(`  git push && git push origin v${version}`);