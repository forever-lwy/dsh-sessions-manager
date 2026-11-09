// Turn a v<version> tag on master into the next commit of the `release` branch.
//
// master holds source only: lib/ is ignored there, and installing it from
// GitHub would run `prepare`, which installs every devDependency and builds.
// The `release` branch (the repository's default branch) holds what gets
// installed: each of its commits is master's tree at a release tag plus the
// built lib/, with `prepare` removed. Its parents are the previous release
// commit and the tagged master commit, so the branch only ever moves forward
// and records which source each release was built from. Installing
// `github:<owner>/<repo>` takes the default branch's tip, needs no
// devDependencies and no build, and dshmarket offers an update when the
// version on that tip rises.
//
// Run on the tagged commit. The script builds and tests it, then writes the
// release commit with plumbing (a temporary index), so the working tree and
// the current branch are untouched; it moves the local `release` branch and
// pushes nothing. .github/workflows/release.yml runs it for every pushed v*
// tag and pushes `release`.
//
//   git tag v0.2.4 && node scripts/release.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const RELEASE_BRANCH = 'refs/heads/release'
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...options }).trim()
const git = (args, options) => run('git', args, options)
const tryGit = (args) => { try { return git(args, { stdio: ['pipe', 'pipe', 'ignore'] }) } catch { return null } }
const fail = (message) => { console.error(`release: ${message}`); process.exit(1) }
const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '')?.slice(1).map(Number) ?? null
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }

if (git(['status', '--porcelain']) !== '') fail('working tree is not clean; commit the source first')
const source = git(['rev-parse', 'HEAD'])
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = `v${manifest.version}`
const tagged = tryGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])
if (tagged !== source) fail(`${tag} (package.json ${manifest.version}) must point at HEAD ${source}; it points at ${tagged ?? 'nothing'}`)
if (parse(manifest.version) === null) fail(`package.json version ${manifest.version} is not a plain x.y.z`)
const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(repository ?? '')?.[1]
if (repo === undefined) fail('package.json needs a GitHub repository field')

const previous = tryGit(['rev-parse', '--verify', '--quiet', RELEASE_BRANCH])
if (previous !== null) {
  const released = JSON.parse(git(['show', `${previous}:package.json`])).version
  if (parse(released) !== null && compare(parse(manifest.version), parse(released)) <= 0) {
    fail(`release already carries ${released}; ${tag} must be newer`)
  }
}

rmSync(join(root, 'lib'), { recursive: true, force: true })
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
execFileSync('npm', ['test'], { cwd: root, stdio: 'inherit' })
const targets = (value) => typeof value === 'string' ? [value]
  : value !== null && typeof value === 'object' ? Object.values(value).flatMap(targets) : []
for (const file of [manifest.main, ...targets(manifest.exports)]) {
  if (typeof file === 'string' && /^(\.\/)?lib\//.test(file) && !existsSync(join(root, file))) fail(`missing build output ${file}`)
}
if (git(['status', '--porcelain']) !== '') fail('build or tests changed tracked files')

const releasedManifest = structuredClone(manifest)
for (const script of ['prepare', 'prepack', 'prepublish', 'prepublishOnly']) delete releasedManifest.scripts?.[script]

// The source commit's author signs the release when git has no identity.
const env = { ...process.env, GIT_INDEX_FILE: join(git(['rev-parse', '--absolute-git-dir']), 'release-index') }
if (tryGit(['config', 'user.email']) === null) {
  const [name, email] = git(['log', '-1', '--format=%an%n%ae', source]).split('\n')
  Object.assign(env, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })
}
const withIndex = (args, input) => git(args, { env, ...(input === undefined ? {} : { input }) })
try {
  withIndex(['read-tree', source])
  withIndex(['add', '--force', '--', 'lib'])
  const blob = withIndex(['hash-object', '-w', '--stdin'], `${JSON.stringify(releasedManifest, null, 2)}\n`)
  withIndex(['update-index', '--cacheinfo', `100644,${blob},package.json`])
  const tree = withIndex(['write-tree'])
  const parents = [...(previous === null ? [] : ['-p', previous]), '-p', source]
  const commit = withIndex(['commit-tree', tree, ...parents, '-m', `release: ${tag}\n\nBuilt from ${source}.`])
  git(['update-ref', RELEASE_BRANCH, commit, ...(previous === null ? [] : [previous])], { env })
  const install = `github:${repo}`
  console.log(`\nrelease ${tag}\n  source  ${source}\n  release ${commit}\n  install ${install}  (default branch: release)`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## ${manifest.name} ${tag}\n\n- source: \`${source}\`\n- release: \`${commit}\`\n\nInstall (with \`release\` as the default branch):\n\n\`\`\`text\n${install}\n\`\`\`\n`)
  }
} finally {
  rmSync(env.GIT_INDEX_FILE, { force: true })
}
