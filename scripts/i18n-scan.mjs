// Reports CJK string literals / JSX text not inside T()/Tx() calls, per file.
import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
const CJK = /[　-〿一-鿿＀-￯]/;
const root = process.cwd();
const verbose = process.argv.includes('-v');
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
function files(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'i18n' ? [] : files(f);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [f] : [];
  });
}
let total = 0;
for (const file of files(path.join(root, 'src'))) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (only.length && !only.some((o) => rel.includes(o))) continue;
  const code = fs.readFileSync(file, 'utf8');
  let ast;
  try { ast = parseAst(code, { lang: file.endsWith('x') ? 'tsx' : 'ts' }); } catch (e) { console.log(rel, 'PARSE ERROR', e.message.slice(0, 200)); continue; }
  const hits = [];
  const visit = (n, inT) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((c) => visit(c, inT));
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && (n.callee.name === 'T' || n.callee.name === 'Tx')) {
      visit(n.callee, inT);
      n.arguments.forEach((a, i) => visit(a, i === 0 ? true : inT && false));
      return;
    }
    // throw new Error(...) is allowed untranslated only if not user-facing; still report.
    let text = null;
    if (n.type === 'Literal' && typeof n.value === 'string') text = n.value;
    else if (n.type === 'TemplateElement') text = n.value.cooked ?? n.value.raw;
    else if (n.type === 'JSXText') text = n.value;
    if (text && CJK.test(text) && !inT) hits.push([code.slice(0, n.start).split('\n').length, text.trim().slice(0, 70)]);
    for (const [k, v] of Object.entries(n)) if (k !== 'parent' && v && typeof v === 'object') visit(v, inT);
  };
  visit(ast, false);
  if (hits.length) {
    total += hits.length;
    console.log(`${hits.length}\t${rel}`);
    if (verbose) for (const [l, t] of hits) console.log(`   ${l}: ${t}`);
  }
}
console.log('TOTAL', total);
