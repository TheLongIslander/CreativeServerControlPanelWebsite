const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('importing preview routes creates no cache directories or worker handles', async t => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'preview-import-'));
  const videoCacheDir = path.join(tempRoot, 'video-cache');
  const previewModulePath = path.join(__dirname, '..', 'backend', 'routes', 'preview.js');
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));

  const script = `
    const fs = require('node:fs');
    process.env.VIDEO_CACHE_DIR = ${JSON.stringify(videoCacheDir)};
    const preview = require(${JSON.stringify(previewModulePath)});
    setImmediate(async () => {
      await preview.closePreviewResources();
      process.stdout.write(JSON.stringify({
        cacheExists: fs.existsSync(${JSON.stringify(videoCacheDir)}),
        hasCleanup: typeof preview.closePreviewResources === 'function'
      }));
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ['-e', script], { timeout: 3000 });
  const result = JSON.parse(stdout);

  assert.equal(result.cacheExists, false);
  assert.equal(result.hasCleanup, true);
});
