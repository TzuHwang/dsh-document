// Publishes a release as a git tag DSH installs from. Run on a built checkout
// of tag vX.Y.Z (the release workflow does):
//
//   node scripts/release.mjs v0.1.0 [--dry-run] [--no-push]
//
// It sets package.json's version, commits the built lib/ (ignored on ordinary
// branches) on a detached HEAD, and pushes tag `<tag>-dist`. Adapted from
// dsh-editor-template/scripts/release.mjs.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const push = !args.includes('--no-push')
const tag = args.find(arg => !arg.startsWith('--'))

if (tag === undefined || !/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) {
  console.error('usage: node scripts/release.mjs vX.Y.Z [--dry-run] [--no-push]')
  process.exit(2)
}
for (const file of ['lib/host.js', 'lib/client.js']) {
  if (!existsSync(join(root, file))) throw new Error(`${file} missing; run pnpm build before releasing`)
}

const distTag = `${tag}-dist`
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
const repo = process.env.GITHUB_REPOSITORY ?? 'TzuHwang/dsh-document'
const installCommand = execFileSync(process.execPath, [join(root, 'scripts/install-command.mjs'), '--project', `github:${repo}#${distTag}`], { cwd: root }).toString().trim()

if (dryRun) {
  console.log(`dry run: would set version ${tag.slice(1)}, commit lib/ and push tag ${distTag}\n\n${installCommand}`)
  process.exit(0)
}

const manifestFile = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
manifest.version = tag.slice(1)
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

git('checkout', '--detach')
git('add', '--force', 'lib', 'package.json')
git('commit', '--message', `release: ${tag} (built)`)
git('tag', distTag)
if (push) git('push', 'origin', distTag)
console.log(`${push ? 'pushed' : 'tagged'} ${distTag}. Install with:\n\n${installCommand}`)
