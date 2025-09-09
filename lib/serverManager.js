// Full updated lib/serverManager.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const axios = require('axios');

const oraModule = require('ora');
const ora = (oraModule && oraModule.default) ? oraModule.default : oraModule;

const treeKill = require('tree-kill');

const rimrafModule = require('rimraf');
const rimraf = (rimrafModule && rimrafModule.default) ? rimrafModule.default : rimrafModule;

const serversDir = path.join(os.homedir(), '.mine-servers');
if (!fs.existsSync(serversDir)) {
  fs.mkdirSync(serversDir);
}

function removeDirSync(dirPath) {
  try {
    if (rimraf && typeof rimraf === 'function') {
      if (typeof rimraf.sync === 'function') {
        rimraf.sync(dirPath);
        return;
      }
    }
  } catch (e) {
    // ignore and fallback to fs.rmSync
  }

  // Fallback: use fs.rmSync (Node 14.14+ supports recursive)
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    // final fallback: try fs.rmdirSync (older nodes)
    try {
      fs.rmdirSync(dirPath, { recursive: true });
    } catch (e) {
      // if still failing, rethrow original error
      throw err;
    }
  }
}

async function checkJava() {
  return new Promise((resolve, reject) => {
    const proc = spawn('java', ['-version']);
    let errored = false;
    proc.on('error', () => {
      errored = true;
      reject(new Error('Java is not installed or not in PATH. Please install Java or use OpenJDK.'));
    });
    proc.on('close', (code) => {
      if (!errored && code !== 0) {
        reject(new Error('Java check failed. Ensure Java is properly installed.'));
      } else if (!errored) {
        resolve();
      }
    });
  });
}

async function getPaperDownloadUrl(version) {
  const { data: project } = await axios.get('https://api.papermc.io/v2/projects/paper');
  if (!project.versions.includes(version)) {
    throw new Error(`Invalid Minecraft version: ${version}`);
  }
  const { data: versionData } = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
  const latestBuild = versionData.builds[versionData.builds.length - 1];
  const { data: buildData } = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}`);
  const jarName = buildData.downloads.application.name;
  return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}/downloads/${jarName}`;
}

async function getVanillaDownloadUrl(version) {
  try {
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const { data: manifest } = await axios.get(manifestUrl);
    const versionInfo = manifest.versions.find(v => v.id === version);
    if (!versionInfo) {
      throw new Error(`Invalid Minecraft version: ${version} for vanilla.`);
    }
    const { data: versionData } = await axios.get(versionInfo.url);
    const serverUrl = versionData.downloads.server.url;
    return serverUrl;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      throw new Error(`Vanilla server for version ${version} not found.`);
    }
    throw new Error(`Failed to fetch vanilla server download: ${err.message}`);
  }
}

async function buildSpigot(version, outputDir) {
  const tmpDir = path.join(os.tmpdir(), `spigot-build-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir);
    const buildToolsUrl = 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar';
    const buildToolsPath = path.join(tmpDir, 'BuildTools.jar');

    const { data: stream } = await axios.get(buildToolsUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(buildToolsPath);
    stream.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const spinner = ora('Building Spigot server... This may take several minutes.').start();
    const { spawn } = require('child_process');
    const child = spawn('java', ['-jar', 'BuildTools.jar', '--rev', version], {
      cwd: tmpDir,
      stdio: 'inherit', // Show build progress to user
    });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          spinner.succeed('Spigot server built successfully.');
          resolve();
        } else {
          spinner.fail('Failed to build Spigot server.');
          reject(new Error(`BuildTools exited with code ${code}. Ensure Java is installed and version is valid.`));
        }
      });
      child.on('error', (err) => {
        spinner.fail();
        reject(err);
      });
    });

    const sourceJar = path.join(tmpDir, 'spigot.jar');
    if (!fs.existsSync(sourceJar)) {
      throw new Error('Spigot JAR was not generated after build.');
    }
    const targetJar = path.join(outputDir, 'spigot.jar');
    fs.renameSync(sourceJar, targetJar);
  } finally {
    try {
      removeDirSync(tmpDir);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

async function createServer(name, { version, ram, port, acceptEula, type = 'vanilla' }) {
  const serverDir = path.join(serversDir, name);
  if (fs.existsSync(serverDir)) {
    throw new Error(`Server "${name}" already exists.`);
  }

  let jarName;
  let url;
  const spinner = ora(`Downloading ${type} server JAR...`).start();

  try {
    fs.mkdirSync(serverDir);

    if (type === 'paper') {
      url = await getPaperDownloadUrl(version);
      jarName = 'paper.jar';
    } else if (type === 'spigot') {
      await buildSpigot(version, serverDir);
      jarName = 'spigot.jar';
      spinner.succeed(`${type} server ready.`); // Spinner handled in buildSpigot
      // Skip the stream download since buildSpigot handles it
    } else if (type === 'vanilla') {
      url = await getVanillaDownloadUrl(version);
      jarName = `minecraft_server.${version}.jar`;
    } else {
      throw new Error(`Invalid server type: ${type}. Must be paper, spigot, or vanilla.`);
    }

    // For paper and vanilla, download the JAR
    if (type !== 'spigot') {
      const jarPath = path.join(serverDir, jarName);
      const { data: stream } = await axios.get(url, { responseType: 'stream' });
      const writer = fs.createWriteStream(jarPath);
      stream.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', () => {
          spinner.succeed(`${type} JAR downloaded.`);
          resolve();
        });
        writer.on('error', (err) => {
          spinner.fail(`Failed to download ${type} JAR.`);
          reject(err);
        });
      });
    }

    // Write server.properties
    fs.writeFileSync(path.join(serverDir, 'server.properties'), `server-port=${port}\n`);

    // Write eula.txt if requested
    if (acceptEula) {
      fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
    }

    // Write config.json including type and jarName
    const config = { ram, version, port, type, jarName };
    fs.writeFileSync(path.join(serverDir, 'config.json'), JSON.stringify(config, null, 2));

    // Write start scripts with correct jarName
    const startShContent = `#!/bin/bash\njava -Xms${ram} -Xmx${ram} -jar ${jarName} nogui > server.log 2>&1\n`;
    const startShPath = path.join(serverDir, 'start.sh');
    fs.writeFileSync(startShPath, startShContent);
    try { fs.chmodSync(startShPath, '755'); } catch (_) {}

    const startBatContent = `@echo off\njava -Xms${ram} -Xmx${ram} -jar ${jarName} nogui > server.log 2>&1\n`;
    fs.writeFileSync(path.join(serverDir, 'start.bat'), startBatContent);

  } catch (err) {
    try { spinner.fail(`Failed to create ${type} server.`); } catch (_) {}
    // Clean up on failure
    try {
      if (fs.existsSync(serverDir)) {
        removeDirSync(serverDir);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
    throw err;
  }
}

async function startServer(name) {
  await checkJava();
  const serverDir = path.join(serversDir, name);
  if (!fs.existsSync(serverDir)) {
    throw new Error(`Server "${name}" not found.`);
  }
  const configPath = path.join(serverDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config for server "${name}" not found.`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const pidPath = path.join(serverDir, 'run.pid');
  const logPath = path.join(serverDir, 'server.log');

  if (fs.existsSync(pidPath)) {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));
    if (isProcessRunning(pid)) {
      throw new Error(`Server "${name}" is already running.`);
    }
    fs.unlinkSync(pidPath);
  }

  // Ensure jarName exists in config (backward compatibility or error if missing)
  if (!config.jarName) {
    throw new Error(`JAR name not found in config for server "${name}". Recreate the server.`);
  }

  const child = spawn('java', [`-Xms${config.ram}`, `-Xmx${config.ram}`, '-jar', config.jarName, 'nogui'], {
    cwd: serverDir,
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  });
  child.unref();
  fs.writeFileSync(pidPath, child.pid.toString());
}

async function stopServer(name) {
  const serverDir = path.join(serversDir, name);
  const pidPath = path.join(serverDir, 'run.pid');
  if (!fs.existsSync(pidPath)) {
    throw new Error(`Server "${name}" is not running.`);
  }
  const pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
  if (!isProcessRunning(pid)) {
    try { fs.unlinkSync(pidPath); } catch(_) {}
    throw new Error(`Server "${name}" is not running.`);
  }

  // try tree-kill first (cross-platform)
  try {
    await new Promise((resolve, reject) => {
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    // success: remove pid and return
    try { fs.unlinkSync(pidPath); } catch(_) {}
    return;
  } catch (err) {
    // fallthrough to other methods if treeKill failed
    // if error indicates taskkill wasn't found, we'll try alternative approaches
  }

  // If we're on Windows, try calling taskkill with full path
  if (process.platform === 'win32') {
    try {
      const taskkillPath = 'C:\\Windows\\System32\\taskkill.exe';
      if (fs.existsSync(taskkillPath)) {
        const { spawnSync } = require('child_process');
        const res = spawnSync(taskkillPath, ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
        if (res.status === 0) {
          try { fs.unlinkSync(pidPath); } catch(_) {}
          return;
        }
      }
    } catch (_) {
      // ignore and try powershell next
    }

    // try PowerShell Stop-Process as last resort
    try {
      const { spawnSync } = require('child_process');
      const cmd = `Stop-Process -Id ${pid} -Force -Confirm:$false`;
      const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' });
      if (res.status === 0) {
        try { fs.unlinkSync(pidPath); } catch(_) {}
        return;
      }
    } catch (_) {
      // ignore
    }
  }

  // If we reach here, we failed to kill the process
  throw new Error(`Failed to stop server "${name}" (pid ${pid}). Try stopping it manually (taskkill or Stop-Process).`);
}

async function restartServer(name) {
  try {
    await stopServer(name);
  } catch (err) {
    if (err.message !== `Server "${name}" is not running.`) {
      throw err;
    }
  }
  await startServer(name);
}

function getStatus(name) {
  const serverDir = path.join(serversDir, name);
  if (!fs.existsSync(serverDir)) {
    throw new Error(`Server "${name}" not found.`);
  }
  const pidPath = path.join(serverDir, 'run.pid');
  if (!fs.existsSync(pidPath)) {
    return 'stopped';
  }
  const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));
  if (isProcessRunning(pid)) {
    return 'running';
  }
  fs.unlinkSync(pidPath);
  return 'stopped';
}

function listServers() {
  const entries = fs.readdirSync(serversDir, { withFileTypes: true });
  const servers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return servers.map((name) => ({
    name,
    status: getStatus(name),
  }));
}

async function deleteServer(name) {
  const serverDir = path.join(serversDir, name);
  if (!fs.existsSync(serverDir)) {
    throw new Error(`Server "${name}" not found.`);
  }
  if (getStatus(name) === 'running') {
    await stopServer(name);
  }
  removeDirSync(serverDir);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

module.exports = {
  createServer,
  startServer,
  stopServer,
  restartServer,
  getStatus,
  listServers,
  deleteServer,
};