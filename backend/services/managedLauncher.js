/* Launch existing administrator-selected scripts with an explicit working
 * directory and exact Screen identity. Original launch files stay untouched. */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

// Separate shell comments without confusing a quoted # or an escaped quote.
function scriptParts(script) {
  return script.split('\n').map(line => {
    let quoteMark = null, escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\' && quoteMark !== "'") { escaped = true; continue; }
      if (quoteMark) { if (character === quoteMark) quoteMark = null; continue; }
      if (character === '"' || character === "'") { quoteMark = character; continue; }
      if (character === '#' && (index === 0 || /\s/.test(line[index - 1]))) return { code: line.slice(0, index), comment: line.slice(index) };
    }
    return { code: line, comment: '' };
  });
}

async function prepareManagedLaunch(context, destination) {
  const original = await fs.readFile(context.startCommandPath, 'utf8');
  if (Buffer.byteLength(original) > 128 * 1024) throw new Error('Launch script is too large.');
  if (path.resolve(destination) === path.resolve(context.startCommandPath)) throw new Error('The managed launcher must not replace the source script.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(context.screenSession)) throw new Error('Invalid Screen identity.');
  const launch = context.launch || {};
  const interpreter = original.match(/^#!([^\r\n]+)/)?.[1] || '/bin/sh';
  const parts = scriptParts(original.replace(/^#![^\n]*(?:\n|$)/, ''));
  let code = () => parts.map(part => part.code).join('\n');
  const transform = callback => { for (const part of parts) part.code = callback(part.code); };
  // Existing Screen launchers retain their own detachment flags. Explicitly
  // rewrite the selected session instead of nesting a second Screen session.
  const screenScript = /\bscreen\s/.test(code());
  if (screenScript) {
    if (!/\bscreen\s+-S\s+(?:"[^"]+"|'[^']+'|[\w.-]+)/.test(code())) {
      throw new Error('Screen launch script must contain an explicit -S session name.');
    }
    transform(line => line.replace(/(\bscreen\s+-S\s+)(?:"[^"]+"|'[^']+'|[\w.-]+)/g, (_, prefix) => `${prefix}${quote(context.screenSession)}`));
  }
  if (launch.ramOverride !== false && launch.heapMb != null) {
    const maximum = Number(launch.heapMb), initial = Number(launch.initialHeapMb ?? maximum);
    if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > 262144 || !Number.isSafeInteger(initial) || initial < 128 || initial > maximum) throw new Error('Invalid configured Java heap.');
    if (!/-Xmx\d+[gGmMkK]?/.test(code()) || !/-Xms\d+[gGmMkK]?/.test(code())) throw new Error('Heap override requires explicit Xms and Xmx launch flags.');
    transform(line => line.replace(/-Xmx\d+[gGmMkK]?/g, `-Xmx${maximum}M`).replace(/-Xms\d+[gGmMkK]?/g, `-Xms${initial}M`));
  }
  if (launch.javaPath) {
    if (!path.isAbsolute(launch.javaPath)) throw new Error('Java executable must be an absolute path.');
    const javaPattern = /"[^"\n]*\/java"|'[^'\n]*\/java'|\/[^\s"']*\/java|\bjava(?=\s)/;
    let replaced = false;
    transform(line => {
      if (replaced || !javaPattern.test(line)) return line;
      replaced = true;
      return line.replace(javaPattern, () => quote(launch.javaPath));
    });
    if (!replaced) throw new Error('Java executable could not be identified in the launch script.');
  }
  // Canonical scripts change to their own directory; a managed copy still
  // needs that directory to be the configured server, including paths with spaces.
  transform(line => line.replace(/^\s*cd\s+.*$/, () => `cd ${quote(context.rootPath)} || exit 1`));
  if (/\$\(dirname\s+"\$0"\)/.test(code())) {
    throw new Error('Launch script uses its own location outside a cd command. Use an explicit server directory.');
  }
  // Preserve GUI/headless arguments exactly as selected by the source script.
  const script = parts.map(part => part.code + part.comment).join('\n');
  const body = `#!${interpreter}\ncd ${quote(context.rootPath)} || exit 1\n${script}\n`;
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, body, { mode: 0o700, flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
  return { path: destination, screenScript };
}

function createManagedLauncher(context, destination, exec = run) {
  return async () => {
    const prepared = await prepareManagedLaunch(context, destination);
    const args = prepared.screenScript ? [] : ['-dmS', context.screenSession, prepared.path];
    await exec(prepared.screenScript ? prepared.path : 'screen', args, { cwd: context.rootPath, timeout: 20000, windowsHide: true });
  };
}

module.exports = { createManagedLauncher, prepareManagedLaunch, scriptParts };
