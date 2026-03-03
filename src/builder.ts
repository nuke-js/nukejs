import { build } from "esbuild";
import fs from "fs";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

// Equivalent of __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.resolve(__dirname, "");
const outDir = path.resolve(__dirname, "../dist");
const excludeFolder = "as-is";

// --- Step 0: Clean dist folder ---
function cleanDist(dir: string) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`🗑️ Cleared dist folder: ${dir}`);
}

// --- Step 1: Collect entry points ---
function collectFiles(dir: string, exclude: string[]): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!exclude.includes(entry.name)) {
        files.push(...collectFiles(fullPath, exclude));
      }
    } else if (entry.isFile() && fullPath.match(/\.[tj]s$/)) {
      files.push(fullPath);
    }
  }

  return files;
}

const entryPoints = collectFiles(srcDir, [excludeFolder]);

// --- Step 2: Build with esbuild ---
async function runBuild() {
  try {
    cleanDist(outDir); // Clear dist first

    console.log("🚀 Starting esbuild...");
    await build({
      entryPoints,
      outdir: outDir,
      platform: "node",
      format: "esm",
      target: ["node20"],
      packages: "external",
      sourcemap: true,
    });
    console.log("✅ Build finished.");

    // --- Step 3: Copy as-is folder ---
    copyFolder(path.join(srcDir, excludeFolder), path.join(outDir, excludeFolder));

    // --- Step 4: Post-process .js files ---
    processDist(outDir);

    // --- Step 5: Compile types ---
    console.log("📄 Generating TypeScript types...");
    execSync("tsc --emitDeclarationOnly --declaration --outDir dist", {
      stdio: "inherit",
    });

    console.log("🎉 Build complete. dist folder is ready!");
  } catch (err) {
    console.error("❌ Build failed:", err);
    process.exit(1);
  }
}

// --- Copy folder recursively ---
function copyFolder(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyFolder(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log(`📁 Copied as-is folder to ${dest}`);
}

// --- Post-process .js files ---
function processDist(dir: string) {
  const excludeFolder = "as-is";

  (function walk(currentDir: string) {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach((d) => {
      const fullPath = path.join(currentDir, d.name);

      if (d.isDirectory()) {
        if (d.name !== excludeFolder) walk(fullPath);
      } else if (fullPath.endsWith(".js")) {
        let content = fs.readFileSync(fullPath, "utf-8");

        // Replace import/export paths ending with .ts → .js, skip paths containing excludeFolder
        content = content.replace(
          /from\s+['"](\.\/(?!as-is\/).*?)['"]/g,
          'from "$1.js"'
        );
        content = content.replace(
          /import\(['"](\.\/(?!as-is\/).*?)['"]\)/g,
          'import("$1.js")'
        );

        fs.writeFileSync(fullPath, content, "utf-8");
      }
    });
  })(dir);

  console.log("🔧 Post-processing done: .ts imports → .js (excluding as-is folder).");
}

// Run the full build
runBuild();