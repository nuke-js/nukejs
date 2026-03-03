#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
const srcDir = path.join(__dirname, '../src');

const arg = process.argv[2];

// ── helpers ───────────────────────────────────────────────────────────────────

function spawnWith(bin, args, extraEnv = {}) {
  const child = spawn(bin, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

const isWindows = process.platform === 'win32';

function resolveBin(name) {
  // On Windows, .bin/ entries are .cmd wrappers — must include the extension
  const candidates = isWindows ? [name + '.cmd', name + '.ps1', name] : [name];

  const searchDirs = [
    path.join(process.cwd(), 'node_modules', '.bin'),       // user's project
    path.join(__dirname, '..', 'node_modules', '.bin'),     // nukejs's own deps
  ];

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }

  // last resort: rely on PATH (works if tsx is installed globally)
  return isWindows ? name + '.cmd' : name;
}

function runWithNode(scriptPath, extraEnv = {}) {
  if (!fs.existsSync(scriptPath)) {
    console.error(`\n  ✖  Cannot find ${path.relative(process.cwd(), scriptPath)}`);
    console.error(`     Run "nuke build" first.\n`);
    process.exit(1);
  }
  spawnWith(process.execPath, [scriptPath], extraEnv);
}

const RESTART_CODE = 75;

function runWithTsx(scriptPath, extraEnv = {}) {
  if (!fs.existsSync(scriptPath)) {
    console.error(`\n  ✖  Cannot find ${path.relative(process.cwd(), scriptPath)}`);
    console.error(`     Is the nukejs package intact?\n`);
    process.exit(1);
  }

  const tsx = resolveBin('tsx');

  function launch() {
    // On Windows, .bin/ entries are .cmd wrappers which cannot be spawned
    // directly — they require the shell to interpret them.  Rather than
    // setting shell:true (which triggers DEP0190 and passes args through an
    // unescaped shell string), we invoke cmd.exe explicitly with /c so the
    // arguments remain as a proper array and are never concatenated by Node.
    const [bin, args] = isWindows && tsx.endsWith('.cmd')
      ? ['cmd.exe', ['/c', tsx, scriptPath]]
      : [tsx, [scriptPath]];

    const child = spawn(bin, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      // shell is always false — cmd.exe /c handles .cmd dispatch on Windows,
      // and Unix never needed it.
      shell: false,
    });
    child.on('exit', (code) => {
      if (code === RESTART_CODE) {
        console.log('\n  ↺  Restarting server...\n');
        launch();
      } else {
        process.exit(code ?? 0);
      }
    });
  }

  launch();
}

// ── commands ──────────────────────────────────────────────────────────────────

if (!arg || arg === 'dev') {
  // nuke | nuke dev  →  prefer src/app.ts (monorepo / local dev),
  //                     fall back to dist/app.js (installed package)
  const srcEntry = path.join(srcDir, 'app.ts');
  const distEntry = path.join(distDir, 'app.js');
  const devScript = fs.existsSync(srcEntry) ? srcEntry : distEntry;
  runWithTsx(devScript, { ENVIRONMENT: 'development' });

} else if (arg === 'build') {
  // nuke build  →  run compiled dist via plain node
  const isVercel = !!(
    process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.NOW_BUILDER
  );

  if (isVercel) {
    runWithNode(path.join(distDir, 'build-vercel.js'));
  } else {
    runWithNode(path.join(distDir, 'build-node.js'));
  }

} else {
  console.error(`\n  ✖  Unknown command: "${arg}"`);
  console.error(`     Usage:  nuke [dev|build]\n`);
  process.exit(1);
}
