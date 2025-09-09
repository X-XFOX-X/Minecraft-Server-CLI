const fs = require('fs');
const path = require('path');
const os = require('os');

const serversDir = path.join(os.homedir(), '.mine-servers');

function getServerPropertiesPath(name) {
  return path.join(serversDir, name, 'server.properties');
}

function readProperties(name) {
  const file = getServerPropertiesPath(name);
  if (!fs.existsSync(file)) throw new Error(`Server "${name}" not found`);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const props = {};
  lines.forEach(line => {
    if (line && !line.startsWith('#')) {
      const [key, ...rest] = line.split('=');
      props[key.trim()] = rest.join('=').trim();
    }
  });
  return props;
}

function writeProperties(name, props) {
  const file = getServerPropertiesPath(name);
  const lines = Object.entries(props).map(([k,v]) => `${k}=${v}`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function setProperty(name, key, value) {
  const props = readProperties(name);
  props[key] = value;
  writeProperties(name, props);
}

function getProperty(name, key) {
  const props = readProperties(name);
  return props[key];
}

module.exports = {
  readProperties,
  writeProperties,
  setProperty,
  getProperty
};