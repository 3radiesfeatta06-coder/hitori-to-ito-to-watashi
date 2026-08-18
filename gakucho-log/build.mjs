#!/usr/bin/env node
// logs/*.md を読んで、スマホで見返せる1枚もののHTMLビューア（dist/index.html）を書き出す。
// 依存パッケージなし。実行: node gakucho-log/build.mjs

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const logsDir = join(root, 'logs');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'index.html');

const ROLE_ALIASES = new Map([
	['自分', 'me'],
	['私', 'me'],
	['質問', 'me'],
	['me', 'me'],
	['user', 'me'],
	['学長AI', 'ai'],
	['学長', 'ai'],
	['AI', 'ai'],
	['回答', 'ai'],
	['assistant', 'ai'],
]);

const escapeHtml = (value) =>
	String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

function fail(message) {
	console.error(`エラー: ${message}`);
	process.exit(1);
}

/** --- で囲まれた最小限のフロントマターを読む（title / date / tags / source / note）。 */
function parseFrontmatter(raw, file) {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) fail(`${file}: 先頭の --- で囲まれたフロントマターが見つかりません。`);

	const meta = { tags: [] };
	let currentListKey = null;

	for (const line of match[1].split(/\r?\n/)) {
		if (line.trim() === '') continue;

		const listItem = line.match(/^\s*-\s+(.*)$/);
		if (listItem && currentListKey) {
			meta[currentListKey].push(stripQuotes(listItem[1]));
			continue;
		}

		const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!pair) fail(`${file}: フロントマターの書式が読めません → ${line}`);

		const [, key, rawValue] = pair;
		const value = rawValue.trim();

		if (value === '') {
			meta[key] = [];
			currentListKey = key;
			continue;
		}

		currentListKey = null;
		if (value.startsWith('[') && value.endsWith(']')) {
			meta[key] = value
				.slice(1, -1)
				.split(',')
				.map((item) => stripQuotes(item))
				.filter(Boolean);
		} else {
			meta[key] = stripQuotes(value);
		}
	}

	return { meta, body: match[2] };
}

const stripQuotes = (value) => value.trim().replace(/^["']|["']$/g, '').trim();

/** 本文を「## 自分」「## 学長AI」の見出しで発言に切り分ける。 */
function parseMessages(body, file) {
	const parts = body.split(/^##[ \t]+(.+?)[ \t]*$/m);
	if (parts.length < 3) fail(`${file}: 「## 自分」「## 学長AI」の見出しが1つも見つかりません。`);

	const messages = [];
	for (let i = 1; i < parts.length; i += 2) {
		const heading = parts[i].trim();
		const role = ROLE_ALIASES.get(heading);
		if (!role) {
			fail(`${file}: 見出し「## ${heading}」は自分／学長AIのどちらか分かりません。`);
		}
		const text = parts[i + 1].trim();
		if (text === '') fail(`${file}: 「## ${heading}」の中身が空です。`);
		messages.push({ role, text });
	}
	return messages;
}

function formatDate(value, file) {
	const date = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(date.valueOf())) fail(`${file}: date は YYYY-MM-DD で書いてください（今: ${value}）。`);
	const parts = new Intl.DateTimeFormat('ja-JP', {
		timeZone: 'UTC',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		weekday: 'short',
	}).formatToParts(date);
	const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
	return {
		iso: value,
		short: value.replaceAll('-', '.'),
		long: `${get('year')}年${get('month').replace('月', '')}月${get('day')}日（${get('weekday')}）`,
		sortKey: date.valueOf(),
	};
}

/** 空行で段落に、単独の改行は <br> にする。 */
function renderText(text) {
	return text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => `<p>${escapeHtml(block).replaceAll('\n', '<br />')}</p>`)
		.join('');
}

const summarize = (text, length = 62) => {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

async function loadLogs() {
	let files;
	try {
		files = (await readdir(logsDir)).filter((name) => name.endsWith('.md')).sort();
	} catch {
		fail(`${logsDir} が見つかりません。`);
	}

	return files
		.map(async (name) => {
			const raw = await readFile(join(logsDir, name), 'utf8');
			const { meta, body } = parseFrontmatter(raw, name);
			if (!meta.title) fail(`${name}: title がありません。`);
			if (!meta.date) fail(`${name}: date がありません。`);

			const messages = parseMessages(body, name);
			const firstQuestion = messages.find((message) => message.role === 'me') ?? messages[0];

			return {
				file: name,
				title: meta.title,
				date: formatDate(meta.date, name),
				tags: Array.isArray(meta.tags) ? meta.tags : [meta.tags].filter(Boolean),
				source: meta.source ?? 'リベシティ 学長AIチャット',
				note: meta.note ?? '',
				messages,
				preview: summarize(firstQuestion.text),
				turns: messages.filter((message) => message.role === 'me').length,
			};
		})
		.reduce(async (previous, current) => [...(await previous), await current], Promise.resolve([]));
}

function renderLog(log, index) {
	const searchText = [log.title, log.tags.join(' '), ...log.messages.map((message) => message.text)]
		.join(' ')
		.replace(/\s+/g, ' ')
		.toLowerCase();

	const messages = log.messages
		.map(
			(message) => `
					<div class="msg ${message.role}">
						<p class="who">${message.role === 'me' ? '自分' : '学長AI'}</p>
						<div class="bubble">${renderText(message.text)}</div>
					</div>`,
		)
		.join('');

	const tags = log.tags
		.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`)
		.join('');

	return `
			<article class="log" data-search="${escapeHtml(searchText)}" data-tags="${escapeHtml(log.tags.join('|'))}">
				<button class="log-head" type="button" aria-expanded="false" aria-controls="log-${index}">
					<span class="log-date">${escapeHtml(log.date.short)}</span>
					<span class="log-title">${escapeHtml(log.title)}</span>
					<span class="log-preview">${escapeHtml(log.preview)}</span>
					<span class="log-meta">
						<span class="turns">${log.turns}往復</span>${tags}<span class="hits" hidden></span>
					</span>
					<span class="chevron" aria-hidden="true"></span>
				</button>
				<div class="log-body" id="log-${index}" hidden>
					<p class="log-source">${escapeHtml(log.date.long)}・${escapeHtml(log.source)}</p>${messages}
					${log.note ? `<p class="log-note">※ ${escapeHtml(log.note)}</p>` : ''}
				</div>
			</article>`;
}

function renderPage(logs) {
	const tags = [...new Set(logs.flatMap((log) => log.tags))].sort((a, b) => a.localeCompare(b, 'ja'));
	const totalMessages = logs.reduce((sum, log) => sum + log.messages.length, 0);
	const latest = logs[0]?.date.long ?? '—';

	const tagButtons = tags
		.map(
			(tag) =>
				`<button class="chip" type="button" data-tag="${escapeHtml(tag)}" aria-pressed="false">#${escapeHtml(tag)}</button>`,
		)
		.join('');

	const body = logs.length
		? logs.map(renderLog).join('')
		: `<p class="empty">まだログがありません。スクショを文字起こしして <code>gakucho-log/logs/</code> に追加してください。</p>`;

	return `<title>学長AIの記録</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
	rel="stylesheet"
	href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=IBM+Plex+Mono:wght@500&display=swap"
/>
<style>
	:root {
		--paper: #f2f5f2;
		--surface: #ffffff;
		--surface-sunk: #eaefeb;
		--ink: #17232a;
		--ink-soft: #5d6f73;
		--line: #dae3dd;
		--accent: #1e6e5a;
		--accent-soft: #e2efe9;
		--me: #3c5b89;
		--me-soft: #e8edf6;
		--mark: #f7d67c;
		--mark-ink: #3a2c05;
		--shadow: 0 1px 2px rgba(23, 35, 42, 0.06), 0 8px 20px rgba(23, 35, 42, 0.05);
		--display: 'Zen Old Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', serif;
		--body: 'Zen Kaku Gothic New', 'Hiragino Sans', 'Noto Sans JP', sans-serif;
		--mono: 'IBM Plex Mono', ui-monospace, monospace;
	}
	@media (prefers-color-scheme: dark) {
		:root:not([data-theme='light']) {
			--paper: #101619;
			--surface: #182126;
			--surface-sunk: #131c20;
			--ink: #e6eeea;
			--ink-soft: #93a5a2;
			--line: #26343a;
			--accent: #4ec2a1;
			--accent-soft: #17322b;
			--me: #93b4e0;
			--me-soft: #1b2634;
			--mark: #6c5514;
			--mark-ink: #ffeab6;
			--shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 20px rgba(0, 0, 0, 0.28);
		}
	}
	:root[data-theme='dark'] {
		--paper: #101619;
		--surface: #182126;
		--surface-sunk: #131c20;
		--ink: #e6eeea;
		--ink-soft: #93a5a2;
		--line: #26343a;
		--accent: #4ec2a1;
		--accent-soft: #17322b;
		--me: #93b4e0;
		--me-soft: #1b2634;
		--mark: #6c5514;
		--mark-ink: #ffeab6;
		--shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 20px rgba(0, 0, 0, 0.28);
	}

	* {
		box-sizing: border-box;
	}
	body {
		margin: 0;
		padding: 0 0 4rem;
		background: var(--paper);
		color: var(--ink);
		font-family: var(--body);
		font-size: 16px;
		line-height: 1.85;
		-webkit-text-size-adjust: 100%;
	}
	.wrap {
		width: min(100% - 1.6rem, 44rem);
		margin-inline: auto;
	}

	header {
		padding: 2.4rem 0 1.2rem;
	}
	.eyebrow {
		margin: 0 0 0.4rem;
		font-family: var(--mono);
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	h1 {
		margin: 0 0 0.6rem;
		font-family: var(--display);
		font-weight: 700;
		font-size: clamp(1.9rem, 7vw, 2.6rem);
		line-height: 1.25;
		text-wrap: balance;
	}
	.lede {
		margin: 0 0 1rem;
		color: var(--ink-soft);
		font-size: 0.9rem;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.2rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-family: var(--mono);
		font-size: 0.75rem;
		color: var(--ink-soft);
		font-variant-numeric: tabular-nums;
	}
	.counts b {
		color: var(--ink);
		font-weight: 500;
	}

	.controls {
		position: sticky;
		top: 0;
		z-index: 5;
		padding: 0.7rem 0;
		background: color-mix(in srgb, var(--paper) 88%, transparent);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--line);
	}
	.search-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	input[type='search'] {
		flex: 1;
		min-width: 0;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		color: var(--ink);
		font-family: inherit;
		font-size: 16px;
		-webkit-appearance: none;
	}
	input[type='search']:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.ghost {
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		color: var(--ink-soft);
		font-family: var(--body);
		font-size: 0.8rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}
	.chip {
		padding: 0.2rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		color: var(--ink-soft);
		font-family: var(--body);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.chip[aria-pressed='true'] {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--surface);
	}

	main {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 1.4rem;
	}
	.log {
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--surface);
		box-shadow: var(--shadow);
		overflow: hidden;
	}
	.log-head {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.8rem;
		width: 100%;
		padding: 1rem 1.1rem;
		border: 0;
		background: none;
		color: inherit;
		font-family: inherit;
		text-align: left;
		cursor: pointer;
	}
	.log-date {
		grid-column: 1;
		font-family: var(--mono);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}
	.log-title {
		grid-column: 1;
		font-weight: 700;
		font-size: 1.02rem;
		line-height: 1.5;
	}
	.log-preview,
	.log-meta {
		grid-column: 1 / -1;
	}
	.log-preview {
		margin-top: 0.2rem;
		color: var(--ink-soft);
		font-size: 0.82rem;
		line-height: 1.7;
	}
	.log-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.55rem;
		font-size: 0.7rem;
		color: var(--ink-soft);
	}
	.turns,
	.tag,
	.hits {
		padding: 0.05rem 0.55rem;
		border-radius: 999px;
		background: var(--surface-sunk);
	}
	.turns {
		font-family: var(--mono);
		font-variant-numeric: tabular-nums;
	}
	.tag {
		color: var(--accent);
		background: var(--accent-soft);
	}
	.hits {
		background: var(--mark);
		color: var(--mark-ink);
	}
	.chevron {
		grid-column: 2;
		grid-row: 1 / span 2;
		align-self: center;
		width: 0.6rem;
		height: 0.6rem;
		border-right: 2px solid var(--ink-soft);
		border-bottom: 2px solid var(--ink-soft);
		transform: rotate(45deg);
		transition: transform 0.2s ease;
	}
	.log-head[aria-expanded='true'] .chevron {
		transform: rotate(-135deg);
	}

	.log-body {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		padding: 0.4rem 1.1rem 1.4rem;
		border-top: 1px solid var(--line);
	}
	.log-source {
		margin: 0.8rem 0 0;
		font-family: var(--mono);
		font-size: 0.7rem;
		color: var(--ink-soft);
	}
	.msg {
		display: flex;
		flex-direction: column;
		max-width: 92%;
	}
	.msg.me {
		align-self: flex-end;
		align-items: flex-end;
	}
	.msg.ai {
		align-self: flex-start;
	}
	.who {
		margin: 0 0.5rem 0.25rem;
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		color: var(--ink-soft);
	}
	.bubble {
		padding: 0.75rem 1rem;
		border-radius: 14px;
		font-size: 0.92rem;
		line-height: 1.85;
	}
	.me .bubble {
		background: var(--me-soft);
		border: 1px solid color-mix(in srgb, var(--me) 28%, transparent);
		border-bottom-right-radius: 4px;
	}
	.ai .bubble {
		background: var(--accent-soft);
		border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
		border-bottom-left-radius: 4px;
	}
	.bubble p {
		margin: 0 0 0.8em;
	}
	.bubble p:last-child {
		margin-bottom: 0;
	}
	.log-note {
		margin: 0;
		padding-top: 0.6rem;
		border-top: 1px dashed var(--line);
		font-size: 0.78rem;
		color: var(--ink-soft);
	}
	mark {
		padding: 0 0.15em;
		border-radius: 3px;
		background: var(--mark);
		color: var(--mark-ink);
	}
	.empty,
	.no-result {
		margin: 0;
		padding: 2.4rem 1.2rem;
		border: 1px dashed var(--line);
		border-radius: 14px;
		text-align: center;
		color: var(--ink-soft);
		font-size: 0.85rem;
	}
	code {
		padding: 0.1em 0.4em;
		border-radius: 4px;
		background: var(--surface-sunk);
		font-family: var(--mono);
		font-size: 0.85em;
	}
	footer {
		padding-top: 2.4rem;
		color: var(--ink-soft);
		font-size: 0.75rem;
		text-align: center;
	}
	[hidden] {
		display: none !important;
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
		}
	}
</style>

<div class="wrap">
	<header>
		<p class="eyebrow">Gakucho AI · Transcript Archive</p>
		<h1>学長AIの記録</h1>
		<p class="lede">
			リベシティの学長AIチャットは履歴が残らないので、スクリーンショットから文字起こしして手元に残しています。
		</p>
		<ul class="counts">
			<li><b>${logs.length}</b> 会話</li>
			<li><b>${totalMessages}</b> 発言</li>
			<li>最終更新 <b>${escapeHtml(latest)}</b></li>
		</ul>
	</header>

	<div class="controls">
		<div class="search-row">
			<label class="sr-only" for="q" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);">キーワード検索</label>
			<input id="q" type="search" placeholder="キーワードで探す（回答の中まで検索）" autocomplete="off" />
			<button class="ghost" id="toggle-all" type="button">全部ひらく</button>
		</div>
		${tags.length ? `<div class="chips">${tagButtons}</div>` : ''}
	</div>

	<main id="list">${body}</main>
	<p class="no-result" id="no-result" hidden>見つかりませんでした。別の言葉で探してみてください。</p>

	<footer>スクショから文字起こしした個人的な記録です。内容の正確さは元のスクショを確認してください。</footer>
</div>

<script>
	(() => {
		const input = document.querySelector('#q');
		const toggleAll = document.querySelector('#toggle-all');
		const noResult = document.querySelector('#no-result');
		const logs = [...document.querySelectorAll('.log')];
		const chips = [...document.querySelectorAll('.chip')];
		const activeTags = new Set();

		// 検索ハイライト用に、生成直後の吹き出しHTMLを控えておく。
		const paragraphs = logs.map((log) =>
			[...log.querySelectorAll('.bubble p')].map((el) => ({ el, html: el.innerHTML })),
		);

		const escapeForHtml = (value) =>
			value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

		function setOpen(log, open) {
			const head = log.querySelector('.log-head');
			const panel = log.querySelector('.log-body');
			head.setAttribute('aria-expanded', String(open));
			panel.hidden = !open;
		}

		function highlight(index, keyword) {
			for (const { el, html } of paragraphs[index]) {
				if (!keyword) {
					el.innerHTML = html;
					continue;
				}
				el.innerHTML = html
					.split(/(<br\\s*\\/?>)/i)
					.map((chunk) => {
						if (/^<br/i.test(chunk)) return chunk;
						let out = '';
						let rest = chunk;
						let at = rest.toLowerCase().indexOf(keyword);
						while (at !== -1) {
							out += rest.slice(0, at) + '<mark>' + rest.slice(at, at + keyword.length) + '</mark>';
							rest = rest.slice(at + keyword.length);
							at = rest.toLowerCase().indexOf(keyword);
						}
						return out + rest;
					})
					.join('');
			}
		}

		function apply() {
			const raw = input.value.trim().toLowerCase();
			const keyword = escapeForHtml(raw);
			let visible = 0;

			logs.forEach((log, index) => {
				const haystack = log.dataset.search || '';
				const tags = (log.dataset.tags || '').split('|').filter(Boolean);
				const matchesTags = [...activeTags].every((tag) => tags.includes(tag));
				const matchesKeyword = raw === '' || haystack.includes(raw);
				const shown = matchesTags && matchesKeyword;

				log.hidden = !shown;
				if (!shown) return;
				visible += 1;

				const hits = log.querySelector('.hits');
				if (raw === '') {
					hits.hidden = true;
					highlight(index, '');
					return;
				}

				highlight(index, keyword);
				const count = log.querySelectorAll('mark').length;
				hits.hidden = count === 0;
				hits.textContent = count + '件ヒット';
				setOpen(log, true);
			});

			noResult.hidden = visible > 0;
			syncToggleLabel();
		}

		function syncToggleLabel() {
			const shown = logs.filter((log) => !log.hidden);
			const allOpen =
				shown.length > 0 &&
				shown.every((log) => log.querySelector('.log-head').getAttribute('aria-expanded') === 'true');
			toggleAll.textContent = allOpen ? '全部とじる' : '全部ひらく';
			toggleAll.dataset.next = allOpen ? 'close' : 'open';
		}

		for (const log of logs) {
			log.querySelector('.log-head').addEventListener('click', () => {
				const open = log.querySelector('.log-head').getAttribute('aria-expanded') === 'true';
				setOpen(log, !open);
				syncToggleLabel();
			});
		}

		for (const chip of chips) {
			chip.addEventListener('click', () => {
				const tag = chip.dataset.tag;
				if (activeTags.has(tag)) {
					activeTags.delete(tag);
					chip.setAttribute('aria-pressed', 'false');
				} else {
					activeTags.add(tag);
					chip.setAttribute('aria-pressed', 'true');
				}
				apply();
			});
		}

		toggleAll.addEventListener('click', () => {
			const open = toggleAll.dataset.next !== 'close';
			for (const log of logs) if (!log.hidden) setOpen(log, open);
			syncToggleLabel();
		});

		input.addEventListener('input', apply);
		syncToggleLabel();
	})();
</script>
`;
}

const logs = (await loadLogs()).sort((a, b) => b.date.sortKey - a.date.sortKey);
await mkdir(outDir, { recursive: true });
await writeFile(outFile, renderPage(logs), 'utf8');
console.log(`書き出しました: ${outFile}（${logs.length}会話 / ${logs.reduce((sum, log) => sum + log.messages.length, 0)}発言）`);
