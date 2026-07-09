// Deploys the static site to the `gh-pages` branch.
//
//   node scripts/deploy-pages.mjs          # build + prepare-pages + push
//   node scripts/deploy-pages.mjs --no-build  # dist/th07.js already built
//
// Builds the bundle, assembles the Pages tree (scripts/prepare-pages.mjs),
// then makes an orphan commit of that tree and force-pushes it to
// origin/gh-pages -- the standard static-deploy pattern. gh-pages is a
// deploy-only branch with no source history, so the force-push is expected
// and safe (it only ever rewrites the deploy branch, never main).
//
// Requires push access to origin (GitHub credentials in your git env).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pagesDir = join(root, 'dist', 'pages');
const branch = 'gh-pages';
const noBuild = process.argv.includes('--no-build');

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
const out = (cmd, opts = {}) => execSync(cmd, { cwd: root, ...opts }).toString().trim();

if (!noBuild) {
  console.log('==> npm run build');
  run('npm run build');
}
console.log('==> npm run prepare-pages');
run('npm run prepare-pages');
if (!existsSync(join(pagesDir, 'index.html'))) {
  console.error('prepare-pages did not produce dist/pages/index.html — aborting.');
  process.exit(1);
}

// Resolve origin's URL from the source repo; the fresh pages repo has none.
const remoteUrl = out('git remote get-url origin');

console.log(`==> orphan commit of dist/pages -> ${branch}`);
run('git init -q', { cwd: pagesDir });
run(`git checkout -q -b ${branch}`, { cwd: pagesDir });
run('git add -A', { cwd: pagesDir });
// -c supplies a deploy identity for this one commit only (no config written).
run('git -c user.email=pages-deploy@users.noreply.github.com ' +
    '-c user.name="GitHub Pages deploy" ' +
    'commit -q -m "deploy: rebuild GitHub Pages"', { cwd: pagesDir });

console.log(`==> force-push to ${branch} (this rewrites the deploy branch only)`);
run(`git push -f ${remoteUrl} HEAD:refs/heads/${branch}`, { cwd: pagesDir });

console.log(`done. ${branch} updated; GitHub Pages will rebuild from it.`);
