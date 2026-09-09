/**
 * What a skill's scripts appear to reach, read off the source.
 *
 * This is a pattern scan, not analysis. It knows nothing about control flow and
 * it can be defeated on purpose in a dozen ways, the shortest being
 * `await import(['node:child','_process'].join(''))`. So it is not a proof that
 * a skill is safe and the README does not call it one.
 *
 * What it is good for is the accident and the drift. A script that starts
 * calling fetch, or shelling out, when its manifest says it does neither, is
 * caught before the skill ships rather than after somebody installs it. Used
 * that way, a false positive costs one line in the manifest and a false
 * negative costs what it always did, which is why it fails loudly toward
 * requiring a declaration rather than quietly toward allowing one.
 */

/** Comments are stripped first so that mentioning child_process in prose is free. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const SIGNALS = {
  exec: [
    /\bnode:child_process\b/,
    /require\(\s*['"]child_process['"]\s*\)/,
    /\b(?:execFile|execFileSync|execSync|spawnSync)\s*\(/,
    /\bspawn\s*\(/,
    /\bexec\s*\(/,
  ],
  net: [
    /\bfetch\s*\(/,
    /\bnode:(?:net|http|https|dgram|dns|tls)\b/,
    /require\(\s*['"](?:net|http|https|dgram|dns|tls)['"]\s*\)/,
    /\bnew\s+WebSocket\b/,
    /\bXMLHttpRequest\b/,
  ],
  write: [
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|cp|createWriteStream|truncate|chmod|symlink)\s*\(/,
  ],
  read: [
    /\b(?:readFile|readFileSync|readdir|readdirSync|createReadStream|realpath|opendir)\s*\(/,
  ],
};

/** Which capabilities the source looks like it uses. */
export function detect(source) {
  const clean = stripComments(source);
  const found = {};
  for (const [capability, patterns] of Object.entries(SIGNALS)) {
    found[capability] = patterns.some((pattern) => pattern.test(clean));
  }
  return found;
}

/**
 * Compare what the code appears to do against what the manifest declared.
 *
 * Only one direction is an error. Using something undeclared means the
 * manifest is wrong or the code grew a capability nobody reviewed, and both
 * need a person. Declaring something unused is untidy rather than unsafe, so
 * it is a warning, and it stays a warning because a script can legitimately
 * shell out only on a branch this scan cannot see.
 */
export function reconcile(detected, declaration) {
  const errors = [];
  const warnings = [];
  const grantsExec = declaration.exec.length > 0 || declaration.execAll;

  if (detected.exec && !grantsExec) errors.push('runs a child process but does not declare allow-exec');
  if (detected.net && !declaration.net) errors.push('reaches the network but declares allow-net: no');
  if (detected.write && !declaration.write.length) errors.push('writes files but does not declare allow-write');
  if (detected.read && !declaration.read.length) errors.push('reads files but does not declare allow-read');

  if (!detected.exec && grantsExec) warnings.push('declares allow-exec but no child process call was found');
  if (!detected.net && declaration.net) warnings.push('declares allow-net: yes but no network call was found');
  if (!detected.write && declaration.write.length) warnings.push('declares allow-write but no write call was found');

  return { errors, warnings };
}
