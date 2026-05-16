const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SKIP_EXTENSIONS = new Set([
  '.db', '.db-shm', '.db-wal', '.gz', '.ico', '.jpg', '.jpeg', '.lock', '.pdf', '.png', '.sqlite', '.webp', '.zip'
]);

const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/;

function listTrackedFiles(repoRoot = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer'
  });

  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function shouldScan(filePath) {
  return !DEFAULT_SKIP_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function findConflictMarkers(repoRoot = process.cwd(), files = listTrackedFiles(repoRoot)) {
  const conflicts = [];

  for (const file of files) {
    if (!shouldScan(file)) continue;

    const absolutePath = path.join(repoRoot, file);
    const content = fs.readFileSync(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (CONFLICT_MARKER_RE.test(line)) {
        conflicts.push({ file, line: index + 1, marker: line.trim() });
      }
    });
  }

  return conflicts;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const conflicts = findConflictMarkers(repoRoot);

  if (conflicts.length > 0) {
    console.error('Merge conflict markers found:');
    for (const conflict of conflicts) {
      console.error(`${conflict.file}:${conflict.line} ${conflict.marker}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('No merge conflict markers found.');
}

if (require.main === module) {
  main();
}

module.exports = {
  findConflictMarkers,
  listTrackedFiles
};
