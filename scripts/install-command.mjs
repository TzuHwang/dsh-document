// Prints the command that installs this project into a DSH profile.
//
//   pnpm install-command [--profile web] [--project <git url of this project at a built tag>]
//
// DSH profiles install with pnpm's blockExoticSubdeps, which refuses git
// dependencies of installed packages, so the template's packages are listed
// top level next to this project instead of being its dependencies.
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)

const profile = option('--profile', 'web')
const { template, release } = manifest.dshEditor
const project = option('--project', `<git URL of ${manifest.name} at a tag with lib/ built>`)
const templatePackages = ['core', 'text', 'layout-main', 'context']

console.log([
  `dsh plugin --profile ${profile} add`,
  ...templatePackages.map(dir => `  "${template}#${release}&path:/packages/${dir}"`),
  `  "${project}"`,
].join(' \\\n'))
