// Publishing backends for the admin portal. A publish is one git commit that
// changes content/site.json (and adds any uploaded photos under
// assets/uploads/), so it behaves exactly like a developer pushing a commit:
// it shows up in the site repo's `git log`, can be reverted, and triggers the
// site's Netlify deploy.
//
//   local  — commits to a local checkout of the site repo (development).
//   github — commits to GitHub through the REST API (production). Needs
//            GITHUB_TOKEN (fine-grained, "Contents: read & write" on this repo),
//            GITHUB_REPO ("owner/name") and optionally GITHUB_BRANCH.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
export const CONTENT_PATH = 'content/site.json';
export const UPLOAD_DIR = 'assets/uploads';
const UPLOAD_RE = /^assets\/uploads\/[a-z0-9][a-z0-9-]{0,80}\.(jpg|jpeg|png|webp)$/;
const MAX_UPLOAD = 6 * 1024 * 1024;

// Reject anything that isn't the shape index.html renders, so a bad publish
// can't take the site down.
export function validateContent(c) {
  const errs = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(c)) return ['content must be an object'];
  for (const k of ['text', 'images']) if (!isObj(c[k])) errs.push(`${k} must be an object`);
  for (const k of ['story', 'space', 'locations', 'news', 'jobs']) if (!Array.isArray(c[k])) errs.push(`${k} must be a list`);
  if (!isObj(c.menu) || !Array.isArray(c.menu.branches) || !Array.isArray(c.menu.categories)) errs.push('menu must have branches and categories');
  if (c.social !== undefined && !isObj(c.social)) errs.push('social must be an object');
  for (const [k, v] of Object.entries(isObj(c.social) ? c.social : {})) if (typeof v !== 'string' || (v && !/^https:\/\/\S+$/.test(v))) errs.push(`social.${k} must be an https:// link or empty`);
  for (const [k, v] of Object.entries(c.text || {})) if (!isObj(v) || typeof v.vi !== 'string') errs.push(`text.${k} needs a Vietnamese value`);
  for (const [k, v] of Object.entries(c.images || {})) {
    if (!v || typeof v.src !== 'string' || !v.src) errs.push(`images.${k} has no photo`);
    if (!v || !v.alt || !String(v.alt.vi || '').trim()) errs.push(`images.${k} needs a photo description (alt text)`);
  }
  for (const cat of (c.menu && c.menu.categories) || []) {
    const items = [...(cat.dishes || []), ...(cat.subgroups || []).flatMap((s) => s.items || []), ...(cat.addOns || [])];
    const ids = new Set();
    for (const it of items) {
      if (!it.id) errs.push(`menu ${cat.key}: an item has no id`);
      else if (ids.has(it.id)) errs.push(`menu ${cat.key}: duplicate id ${it.id}`);
      ids.add(it.id);
      if (!String(it.nameVi || '').trim()) errs.push(`menu ${cat.key}/${it.id}: needs a Vietnamese name`);
      if (!it.price && !(it.sizes && it.sizes.length)) errs.push(`menu ${cat.key}/${it.id}: needs a price`);
    }
  }
  const json = JSON.stringify(c);
  if (json.length > 2_000_000) errs.push('content is larger than 2 MB');
  return errs;
}

export function checkUploads(files = []) {
  for (const f of files) {
    if (!UPLOAD_RE.test(f.path)) throw new Error(`not an allowed upload path: ${f.path}`);
    if (Buffer.byteLength(f.data || '', 'base64') > MAX_UPLOAD) throw new Error(`${f.path} is larger than 6 MB`);
  }
}

const serialize = (c) => JSON.stringify(c, null, 2) + '\n';
const authorLine = (a) => `${(a.name || 'MUGI admin').replace(/[<>\n]/g, '')} <${(a.email || 'admin@mugi.vn').replace(/[<>\s]/g, '')}>`;

export function localBackend(root) {
  const git = (...args) => run('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 }).then((r) => r.stdout);
  return {
    mode: 'local',
    async status() {
      const [branch, head] = await Promise.all([git('rev-parse', '--abbrev-ref', 'HEAD'), git('rev-parse', '--short', 'HEAD')]);
      return { mode: 'local', branch: branch.trim(), head: head.trim() };
    },
    async read(sha) {
      return JSON.parse(sha ? await git('show', `${sha}:${CONTENT_PATH}`) : await fs.readFile(path.join(root, CONTENT_PATH), 'utf8'));
    },
    async publish({ content, files = [], message, author }) {
      await fs.mkdir(path.join(root, UPLOAD_DIR), { recursive: true });
      for (const f of files) await fs.writeFile(path.join(root, f.path), Buffer.from(f.data, 'base64'));
      await fs.writeFile(path.join(root, CONTENT_PATH), serialize(content));
      // Commit only the content paths, never whatever else is staged.
      const paths = [CONTENT_PATH, ...files.map((f) => f.path)];
      await git('add', '--', ...paths);
      await git('-c', `user.name=${author.name || 'MUGI admin'}`, '-c', `user.email=${author.email || 'admin@mugi.vn'}`,
        'commit', '--only', '-m', message, `--author=${authorLine(author)}`, '--', ...paths);
      return { sha: (await git('rev-parse', '--short', 'HEAD')).trim() };
    },
    async history(limit = 20) {
      const out = await git('log', `-n${limit}`, '--format=%h%x1f%an%x1f%aI%x1f%s', '--', CONTENT_PATH);
      return out.trim().split('\n').filter(Boolean).map((l) => { const [sha, author, date, message] = l.split('\x1f'); return { sha, author, date, message }; });
    },
  };
}

export function githubBackend({ token, repo, branch = 'main' }) {
  const api = async (p, opts = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${p}`, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const fileAt = async (ref) => {
    const f = await api(`/contents/${CONTENT_PATH}?ref=${encodeURIComponent(ref)}`);
    return JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
  };
  return {
    mode: 'github',
    async status() {
      const ref = await api(`/git/ref/heads/${branch}`);
      return { mode: 'github', repo, branch, head: ref.object.sha.slice(0, 7) };
    },
    read: (sha) => fileAt(sha || branch),
    // One commit with every changed file (Git Data API), so a publish is atomic.
    async publish({ content, files = [], message, author }) {
      const ref = await api(`/git/ref/heads/${branch}`);
      const parent = await api(`/git/commits/${ref.object.sha}`);
      const blobs = [{ path: CONTENT_PATH, content: Buffer.from(serialize(content)).toString('base64') }, ...files.map((f) => ({ path: f.path, content: f.data }))];
      const tree = await api('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          base_tree: parent.tree.sha,
          tree: await Promise.all(blobs.map(async (b) => ({
            path: b.path, mode: '100644', type: 'blob',
            sha: (await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: b.content, encoding: 'base64' }) })).sha,
          }))),
        }),
      });
      const who = { name: author.name || 'MUGI admin', email: author.email || 'admin@mugi.vn', date: new Date().toISOString() };
      const commit = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha], author: who }) });
      await api(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      return { sha: commit.sha.slice(0, 7) };
    },
    async history(limit = 20) {
      const list = await api(`/commits?path=${CONTENT_PATH}&sha=${branch}&per_page=${limit}`);
      return list.map((c) => ({ sha: c.sha.slice(0, 7), author: c.commit.author.name, date: c.commit.author.date, message: c.commit.message.split('\n')[0] }));
    },
  };
}
