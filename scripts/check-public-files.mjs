import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
if (!files.length) throw Error('No tracked files to check.');
const failures = [];
for (const path of files) {
  if (
    /(^|\/)(\.secrets|\.private|node_modules|data|profile|downloads)(\/|$)|(^|\/)\.env($|\.(?!example$))|\.(pdf|pem|key)$/i.test(
      path,
    )
  )
    failures.push(path + ': private artifact');
  const text = execFileSync('git', ['show', ':' + path], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|https?:\/\/[^\s/]*\.nip\.io/.test(
      text,
    )
  )
    failures.push(path + ': credential or deployment address');
}
if (failures.length) throw Error(failures.join('\n'));
console.log(
  `Public-file checks passed for ${files.length} tracked files. This is a guardrail, not a complete secret scanner.`,
);
