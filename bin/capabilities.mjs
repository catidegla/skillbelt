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

/**
 * Hosts named outright in the source.
 *
 * Only literals, which is the same bargain the rest of this file makes. A host
 * built at runtime is invisible here, and a skill wanting to hide one has
 * easier ways than string concatenation, so this is not a fence either. What
 * it catches is the ordinary case: somebody adds a call to a new API and the
 * manifest does not mention it.
 *
 * localhost and the loopback addresses are dropped because a skill talking to
 * a service the caller is already running is not reaching out to anybody, and
 * making people declare it would train them to declare everything.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function hosts(source) {
  const clean = stripComments(source);
  const found = new Set();

  for (const [, host] of clean.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)) {
    const name = host.toLowerCase().replace(/\.$/, '');
    if (!LOOPBACK.has(name) && name.includes('.')) found.add(name);
  }

  // node:http and friends take the host as an option rather than a URL.
  for (const [, host] of clean.matchAll(/\b(?:host|hostname)\s*:\s*['"]([A-Za-z0-9.-]+)['"]/g)) {
    const name = host.toLowerCase().replace(/\.$/, '');
    if (!LOOPBACK.has(name)) found.add(name);
  }

  return [...found].sort();
}

/**
 * Whether the source reaches the network somewhere the host cannot be read.
 *
 * A URL out of an environment variable, off a config file, or assembled from
 * parts is invisible to the scan above, and a declared host list that quietly
 * passes such a script is worse than no list at all: it reads as an answer to
 * the question "where does this go" when nobody has answered it.
 *
 * A template literal that begins with the scheme is not dynamic for this
 * purpose. `https://api.example.com/${id}` names its host perfectly well and
 * only varies the path.
 */
export function dynamicTarget(source) {
  const clean = stripComments(source);
  const calls = /\b(?:fetch|request|get|post|put|patch|head)\s*\(\s*([^)]{0,40})/g;

  for (const [, head] of clean.matchAll(calls)) {
    const arg = head.trim();
    if (arg === '' || arg.startsWith('{')) continue;
    // A literal target, quoted or templated, names its host.
    if (/^['"`]\s*https?:\/\//.test(arg)) continue;
    // A bare path against a base the caller supplies is still not a host.
    if (/^['"`]/.test(arg)) continue;
    return true;
  }

  return false;
}

/**
 * Whether the source refuses to spawn when nothing is enforcing its manifest.
 *
 * `allow-exec` is the one grant Node cannot narrow: a skill that declares
 * `allow-exec: php` receives the whole child process capability, and only
 * while `skillbelt run` is the thing that started it. Run directly the
 * declaration is inert, the grant is unbounded, and the manifest reads exactly
 * the same. `process.permission` is how a script tells the difference, since
 * it exists only under `--permission`.
 *
 * So a skill that shells out has to consult it. Otherwise the refusal is a
 * convention that held for as long as somebody remembered it, which is the
 * same failure as documenting the limit in a README and calling it a control.
 *
 * Presence of the reference is all this checks. A script can reference it in a
 * branch that never runs, exactly as it can hide a host behind string
 * concatenation, and the file says elsewhere why that is the bargain: this
 * catches the skill that forgot, not the skill that lied.
 */
export function guardsExec(source) {
  return stripComments(source).includes('process.permission');
}

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

  // The declared-and-used case, which is the one the other rule never reaches.
  // Declaring allow-exec is not a limit Node can apply narrowly, so the only
  // thing standing between a direct `node scripts/x.mjs` and an unbounded
  // spawn is the script checking for itself.
  if (detected.exec && grantsExec && !detected.execGuard) {
    errors.push('spawns a child process without checking process.permission first, so run directly the allow-exec it declares is unenforced and nothing refuses. read the flag and exit rather than spawning');
  }
  if (detected.net && !declaration.net) errors.push('reaches the network but declares allow-net: no');

  // Only checked when the manifest named hosts. Declaring `allow-net: yes`
  // stays exactly as permissive as it reads, because a blanket grant that
  // quietly started failing on an undeclared host would be a trap rather than
  // a stricter default.
  // Declaring hosts is a claim about where the traffic goes, so a target the
  // scan cannot read makes the claim uncheckable and the list has to fail
  // rather than sit there looking satisfied. This is the one place the scan
  // fails closed, and it can: the fix is to use a literal, or to drop back to
  // `allow-net: yes` and say plainly that the destination is not fixed.
  if (declaration.hosts?.length && detected.dynamicTarget) {
    errors.push('builds a request target the manifest cannot be checked against, so the allow-net list proves nothing. use a literal host, or declare allow-net: yes');
  }

  if (declaration.hosts?.length && detected.hosts?.length) {
    const allowed = new Set(declaration.hosts);
    const strangers = detected.hosts.filter(
      (host) => !allowed.has(host) && ![...allowed].some((a) => host.endsWith(`.${a}`)),
    );

    if (strangers.length) {
      errors.push(`contacts ${strangers.join(', ')}, which allow-net does not list`);
    }

    const unused = declaration.hosts.filter(
      (a) => !detected.hosts.some((host) => host === a || host.endsWith(`.${a}`)),
    );

    if (unused.length) warnings.push(`declares ${unused.join(', ')} under allow-net but no call to them was found`);
  }
  if (detected.write && !declaration.write.length) errors.push('writes files but does not declare allow-write');
  if (detected.read && !declaration.read.length) errors.push('reads files but does not declare allow-read');

  if (!detected.exec && grantsExec) warnings.push('declares allow-exec but no child process call was found');
  if (!detected.net && declaration.net) warnings.push('declares allow-net: yes but no network call was found');
  if (!detected.write && declaration.write.length) warnings.push('declares allow-write but no write call was found');

  return { errors, warnings };
}
