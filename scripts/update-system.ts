import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

async function runUpdate() {
  const projectRoot = process.cwd();
  console.log(`[Update Script] Starting system update in ${projectRoot}...`);

  try {
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      console.error("Error: Not a git repository. Updates are disabled.");
      process.exit(1);
    }

    // 1. Stash local changes
    try {
      console.log("[Update Script] Stashing local changes...");
      await execAsync('git stash');
    } catch (e) {
      console.log("[Update Script] No local changes to stash or stash failed (ignoring).");
    }

    // 2. Pull latest changes
    const branch = process.env.GITHUB_BRANCH || 'main';
    console.log(`[Update Script] Pulling latest changes from origin ${branch}...`);
    const pullResult = await execAsync(`git pull origin ${branch}`);
    console.log(pullResult.stdout);

    // 3. Install dependencies
    console.log("[Update Script] Installing dependencies...");
    const installResult = await execAsync('npm install');
    console.log(installResult.stdout);

    // 4. Build the application
    console.log("[Update Script] Building application...");
    const buildResult = await execAsync('npm run build');
    console.log(buildResult.stdout);

    // 5. Verify build
    const distDir = path.join(projectRoot, 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error("Build failed: 'dist' directory not found.");
    }

    console.log("[Update Script] Update successful!");
    console.log("You may need to restart your server process to apply changes.");
    
  } catch (error: any) {
    console.error("[Update Script] Update failed!");
    console.error(error.message);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    process.exit(1);
  }
}

runUpdate();
