import { execFileSync } from 'node:child_process';

const prohibitedDirectories = ['node_modules', 'dist', 'coverage', '.cache'];
const tracked = execFileSync('git', ['ls-files', '--', ...prohibitedDirectories], {
  encoding: 'utf8',
});
const prohibitedFiles = tracked.trim().split('\n').filter(Boolean);

if (prohibitedFiles.length > 0) {
  console.error(`${prohibitedFiles.length} generated files must not be tracked.`);
  console.error(prohibitedFiles.slice(0, 20).join('\n'));
  if (prohibitedFiles.length > 20) console.error('... output limited to the first 20 paths');
  process.exit(1);
}

console.log('Repository hygiene validation passed.');
