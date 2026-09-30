const fs = require('node:fs');
const crypto = require('node:crypto');
const { scriptParts } = require('./managedLauncher');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const overrideEnabled = launch => launch?.ramOverride ?? (launch?.heapMb != null);
function failure(message, status = 400) {
  return Object.assign(new Error(message), { status, code: status === 409 ? 'SERVER_SCRIPT_CONFLICT' : 'SERVER_SCRIPT_HEAP_INVALID' });
}
function parse(text) {
  if (Buffer.byteLength(text) > 128 * 1024 || text.includes('<<')) throw failure('RAM sync requires a simple startup script with explicit heap flags. Use panel override for this script.');
  const parts = scriptParts(text);
  const result = { parts };
  for (const [key, flag] of [['heapMb', 'Xmx'], ['initialHeapMb', 'Xms']]) {
    const code = parts.map(part => part.code).join('\n');
    const matches = [...code.matchAll(new RegExp(`(?<![\\w-])-${flag}(\\d+)([gGmMkK]?)(?=[\\s"';]|$)`, 'g'))];
    if ((code.match(new RegExp(`-${flag}`, 'g')) || []).length !== matches.length || matches.length > 1) {
      throw failure('RAM sync requires one explicit value per heap flag. Use panel override for dynamic or multiple Java commands.');
    }
    const match = matches[0];
    const multiplier = { g: 1024, m: 1, k: 1 / 1024, '': 1 / 1048576 };
    result[key] = match ? Number(match[1]) * multiplier[match[2].toLowerCase()] : null;
  }
  return result;
}
function readScriptHeap(filename) {
  try {
    const text = fs.readFileSync(filename, 'utf8');
    const { heapMb, initialHeapMb } = parse(text);
    return { heapMb, initialHeapMb, revision: hash(text), error: null };
  } catch (error) {
    return { heapMb: null, initialHeapMb: null, revision: null, error: error.code?.startsWith('SERVER_') ? error.message : 'Startup script could not be read.' };
  }
}
function replaceFile(filename, text, mode) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}
// Called only after profile validation, inside the registry's mutation queue.
async function saveWithScriptHeap(profile, input, save) {
  if (overrideEnabled(profile.launch)) return save(profile);
  const requested = input.launch || {};
  const values = ['heapMb', 'initialHeapMb'].filter(key => requested[key] != null);
  profile.launch = { ...profile.launch, heapMb: null, initialHeapMb: null };
  if (!values.length) return save(profile);
  const filename = profile.startCommandPath;
  const original = fs.readFileSync(filename, 'utf8');
  if (input.scriptRevision != null && input.scriptRevision !== hash(original)) throw failure('Startup script changed. Reopen the profile before saving RAM.', 409);
  const parsed = parse(original);
  const effective = { ...parsed, ...Object.fromEntries(values.map(key => [key, requested[key]])) };
  if (effective.initialHeapMb != null && effective.heapMb != null && effective.initialHeapMb > effective.heapMb) throw failure('Initial RAM cannot exceed maximum RAM in the startup script.');
  for (const key of values) {
    if (parsed[key] == null) throw failure('The startup script is missing an explicit heap flag. Add the flag before syncing RAM.');
    if (parsed[key] === requested[key]) continue;
    const flag = key === 'heapMb' ? 'Xmx' : 'Xms';
    for (const part of parsed.parts) part.code = part.code.replace(new RegExp(`-${flag}\\d+[gGmMkK]?`, 'g'), `-${flag}${requested[key]}M`);
  }
  const updated = parsed.parts.map(part => part.code + part.comment).join('\n');
  if (updated === original) return save(profile);
  const mode = fs.statSync(filename).mode & 0o777;
  if (fs.readFileSync(filename, 'utf8') !== original) throw failure('Startup script changed. Reopen the profile before saving RAM.', 409);
  replaceFile(filename, updated, mode);
  try { return await save(profile); }
  catch (error) {
    if (fs.readFileSync(filename, 'utf8') === updated) replaceFile(filename, original, mode);
    throw error;
  }
}
module.exports = { overrideEnabled, readScriptHeap, saveWithScriptHeap };
