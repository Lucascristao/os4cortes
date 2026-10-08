const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const probes = new Map();
async function videoDuration(file, execute = run) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (execute === run && probes.has(key)) return probes.get(key);
  const task = (async () => {
    for (let n = 0; n < 2; n++) {
      try {
        const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 60000, windowsHide: true });
        const duration = Number(stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Duração do vídeo inválida.');
        return duration;
      } catch (error) {
        if (n === 1 || !(error.killed || error.code === 'ETIMEDOUT')) throw error;
      }
    }
  })();
  if (execute === run) {
    if (probes.size > 100) probes.clear();
    probes.set(key, task);
    task.catch(() => probes.delete(key));
  }
  return task;
}
module.exports = { videoDuration };
