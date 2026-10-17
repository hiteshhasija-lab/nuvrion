// A fake host for the pull tools: `ssh` answers the two listing commands from a directory tree and `rsync` copies from that tree with the include and exclude
// rules it was given, so the tests exercise the tools’ own logic (what they ask for, what they check) without a network.
import { cpSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export function fakeRemote(root, { failList = false, failRsyncFor = null } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ssh') {
      if (failList) return { code: 255, stdout: '', stderr: 'ssh: connect to host: Operation timed out' };
      const remote = args.at(-1);
      if (remote.includes('for d in')) {
        const base = join(root, remote.match(/cd (\S+) &&/)[1]);
        const names = existsSync(base) ? readdirSync(base).filter(name => /^\d{8}T\d{6}Z$/.test(name) && existsSync(join(base, name, 'COMPLETE'))) : [];
        return { code: 0, stdout: names.join('\n') + '\n', stderr: '' };
      }
      const listing = /^ls -1 (\S+)$/.exec(remote);
      if (listing) return { code: 0, stdout: readdirSync(join(root, listing[1])).join('\n') + '\n', stderr: '' };
      return { code: 99, stdout: '', stderr: `unexpected remote command ${remote}` };
    }
    if (command === 'rsync') {
      const source = args.find(arg => /@[^:]+:/.test(arg)), destination = args.at(-1);
      const sourcePath = join(root, source.split(':')[1]);
      if (failRsyncFor && sourcePath.includes(failRsyncFor)) return { code: 23, stdout: '', stderr: 'rsync: some files could not be transferred' };
      const includes = args.filter(arg => arg.startsWith('--include=')).map(arg => globToRegExp(arg.slice(10)));
      const excludes = args.filter(arg => arg.startsWith('--exclude=')).map(arg => arg.slice(10));
      const excludeEverything = excludes.includes('*');
      mkdirSync(destination, { recursive: true });
      for (const name of readdirSync(sourcePath)) {
        const isDirectory = statSync(join(sourcePath, name)).isDirectory();
        if (excludeEverything && !includes.some(rule => rule.test(name))) continue;
        if (isDirectory && excludes.includes('*/')) continue;
        if (excludes.some(pattern => pattern !== '*' && pattern !== '*/' && globToRegExp(pattern).test(name))) continue;
        cpSync(join(sourcePath, name), join(destination, basename(name)), { recursive: true });
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 98, stdout: '', stderr: `unexpected command ${command}` };
  };
  return { run, calls };
}
