#!/usr/bin/env node

const path = require('path');
const chalk = require('chalk').default;
const { spawnSync, exec } = require('child_process');

const serverManagerPath = path.resolve(__dirname, '..', 'lib', 'serverManager');
const {
  createServer,
  startServer,
  stopServer,
  restartServer,
  getStatus,
  listServers,
  deleteServer,
} = require(serverManagerPath);
const { setProperty, getProperty } = require('../lib/configManager');

function usage() {
  console.log(`
mine-server <command> [args] [--auto-install-java] [--java-min-version <n>]

Global flags:
  --auto-install-java        Open download page for JDK automatically if Java is missing/too old
  --java-min-version <n>     Minimum required Java major version (default: 17)

Commands:
  create <name> --version <ver> [--ram <ram>] [--port <port>] [--accept-eula]
  start <name>
  stop <name>
  restart <name>
  status <name>
  list
  delete <name>
`);
  process.exit(0);
}

function openUrl(url) {
  const plat = process.platform;
  if (plat === 'win32') {
    exec(`start "" "${url.replace(/"/g, '\\"')}"`);
  } else if (plat === 'darwin') {
    exec(`open "${url.replace(/"/g, '\\"')}"`);
  } else {
    exec(`xdg-open "${url.replace(/"/g, '\\"')}"`);
  }
}

function getJavaMajorVersion() {
  try {
    const res = spawnSync('java', ['-version'], { encoding: 'utf8' });
    const out = (res.stderr || res.stdout || '').toString();
    if (res.error) return null;
    const m = out.match(/version "(.*?)"/) || out.match(/version '(.*?)'/);
    if (!m) return null;
    const ver = m[1]; // e.g. 1.8.0_51 or 17.0.2
    if (ver.startsWith('1.')) {
      // "1.8.0_xx" -> major 8
      const parts = ver.split('.');
      return parseInt(parts[1], 10);
    } else {
      const parts = ver.split('.');
      return parseInt(parts[0], 10);
    }
  } catch (e) {
    return null;
  }
}

async function ensureJava(minMajor, autoInstall) {
  const major = getJavaMajorVersion();
  if (major === null) {
    console.log(chalk.red('Java not found on PATH.'));
    if (autoInstall) {
      console.log(chalk.yellow(`Opening JDK download page for Java ${minMajor}...`));
      openUrl(`https://adoptium.net/temurin/releases/?version=${minMajor}`);
    } else {
      console.log(chalk.yellow(`Please install Java (JDK) version ${minMajor} or newer.`));
      console.log(chalk.yellow('Recommended: Eclipse Temurin (Adoptium) — https://adoptium.net/'));
    }
    return false;
  }
  if (major < minMajor) {
    console.log(chalk.red(`Installed Java major version is ${major}, but ${minMajor} (or newer) is required.`));
    if (autoInstall) {
      console.log(chalk.yellow(`Opening JDK download page for Java ${minMajor}...`));
      openUrl(`https://adoptium.net/temurin/releases/?version=${minMajor}`);
    } else {
      console.log(chalk.yellow('You can either upgrade Java system-wide or run the server with a newer java binary.'));
      console.log(chalk.yellow('To test with a specific java executable:'));
      console.log(chalk.cyan('  "C:\\path\\to\\java.exe" -Xms2G -Xmx2G -jar paper.jar nogui'));
    }
    return false;
  }
  return true;
}

function parseGlobalFlags(raw) {
  const flags = { autoInstallJava: false, javaMinVersion: 17 };
  const args = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--auto-install-java') {
      flags.autoInstallJava = true;
    } else if (a === '--java-min-version') {
      const val = raw[i + 1];
      if (val && !val.startsWith('--')) {
        flags.javaMinVersion = parseInt(val, 10) || flags.javaMinVersion;
        i++;
      } else {
        console.log(chalk.red('Missing value for --java-min-version')); usage();
      }
    } else {
      args.push(a);
    }
  }
  return { flags, args };
}

function parseCreateArgs(args) {
  const result = { ram: '2G', port: '25565', acceptEula: false, version: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--version') {
      result.version = args[++i];
    } else if (a === '--ram') {
      result.ram = args[++i];
    } else if (a === '--port') {
      result.port = args[++i];
    } else if (a === '--accept-eula') {
      result.acceptEula = true;
    } else {
      // ignore unknown for now
    }
  }
  return result;
}

async function main() {
  const raw = process.argv.slice(2);
  if (!raw || raw.length === 0) return usage();

  const { flags, args } = parseGlobalFlags(raw);
  const cmd = args[0];

  try {
    // Commands that require Java: start, restart, create (optional)
    if (cmd === 'start' || cmd === 'restart' || cmd === 'create') {
      const ok = await ensureJava(flags.javaMinVersion, flags.autoInstallJava);
      if (!ok) {
        process.exit(1);
      }
    }

    if (cmd === 'create') {
      const name = args[1];
      if (!name) {
        console.error(chalk.red('Error: create requires a <name> argument.'));
        return usage();
      }
      const opts = parseCreateArgs(args.slice(2));
      if (!opts.version) {
        console.error(chalk.red('Error: --version <version> is required for create.'));
        process.exit(1);
      }
      await createServer(name, {
        version: opts.version,
        ram: opts.ram,
        port: opts.port,
        acceptEula: opts.acceptEula,
      });
      console.log(chalk.green(`Server ${name} created successfully!`));
      return;
    }

    if (cmd === 'start') {
      const name = args[1];
      if (!name) { console.error(chalk.red('start requires <name>')); return usage(); }
      await startServer(name);
      console.log(chalk.green(`Server ${name} started!`));
      return;
    }

    if (cmd === 'stop') {
      const name = args[1];
      if (!name) { console.error(chalk.red('stop requires <name>')); return usage(); }
      await stopServer(name);
      console.log(chalk.green(`Server ${name} stopped!`));
      return;
    }

    if (cmd === 'restart') {
      const name = args[1];
      if (!name) { console.error(chalk.red('restart requires <name>')); return usage(); }
      await restartServer(name);
      console.log(chalk.green(`Server ${name} restarted!`));
      return;
    }

    if (cmd === 'status') {
      const name = args[1];
      if (!name) { console.error(chalk.red('status requires <name>')); return usage(); }
      const status = getStatus(name);
      const color = status === 'running' ? 'green' : 'yellow';
      console.log(`Server ${name} is ${chalk[color](status)}.`);
      return;
    }

    if (cmd === 'list') {
      const servers = listServers();
      if (servers.length === 0) {
        console.log(chalk.yellow('No servers found.'));
        return;
      }
      console.table(servers);
      return;
    }

    if (cmd === 'delete') {
      const name = args[1];
      if (!name) { console.error(chalk.red('delete requires <name>')); return usage(); }
      await deleteServer(name);
      console.log(chalk.green(`Server ${name} deleted!`));
      return;
    }

    // SET PROPERTY
    if (cmd === 'set') {
      const name = args[1];
      const key = args[2];
      const value = args[3];
      if (!name || !key || value === undefined) {
        console.error(chalk.red('Usage: mine-server set <name> <key> <value>'));
        return usage();
      }
      try {
        setProperty(name, key, value);
        console.log(chalk.green(`Property "${key}" set to "${value}" for server ${name}`));
      } catch (err) {
        console.error(chalk.red('Error:'), err.message);
        process.exit(1);
      }
      return;
    }

    // GET PROPERTY
    if (cmd === 'get') {
      const name = args[1];
      const key = args[2];
      if (!name || !key) {
        console.error(chalk.red('Usage: mine-server get <name> <key>'));
        return usage();
      }
      try {
        const value = getProperty(name, key);
        if (value !== undefined) {
          console.log(value);
        } else {
          console.log(chalk.yellow(`Property "${key}" not found for server ${name}`));
        }
      } catch (err) {
        console.error(chalk.red('Error:'), err.message);
        process.exit(1);
      }
      return;
    }

    if (cmd === '--help' || cmd === '-h') return usage();
    if (cmd === '--version' || cmd === '-v') {
      console.log('0.0.1');
      return;
    }

    console.error(chalk.red(`Unknown command: ${cmd}`));
    usage();
  } catch (err) {
    console.error(chalk.red('Error:'), err.message || err);
    process.exit(1);
  }
}

main();