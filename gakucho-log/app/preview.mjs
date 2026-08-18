#!/usr/bin/env node
// 配布用の index.html から、Artifact 公開用の断片（dist/app-preview.html）を作る。
// Artifact 側が <!doctype>〜<body> を用意するので、その外枠だけ取り除く。
// 実行: node gakucho-log/app/preview.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'index.html');
const outFile = join(here, '..', 'dist', 'app-preview.html');

const html = await readFile(source, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';

// charset や viewport は公開側の <head> が持っているので落とす。
const headKept = head.replace(/^\s*<meta\b[^>]*>\s*$/gm, '').trim();

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${headKept}\n${body.trim()}\n`, 'utf8');
console.log(`書き出しました: ${outFile}`);
