---
name: yuque-export
description: Export a public Yuque (语雀) document to Markdown, Word (.docx) and PDF with all images embedded, so one file can be shared or imported elsewhere. This skill should be used when the user pastes a yuque.com link and wants it downloaded, backed up, archived, converted to Word or PDF, handed to people who do not use Yuque, or migrated into Obsidian, Typora or a Git repo. Trigger phrases include 下载语雀, 语雀导出, 语雀转 Word, 语雀转 PDF, 保存语雀文档, yuque export, yuque to docx, yuque to pdf.
agent_created: true
---

# Yuque Export

Turn a public Yuque document into local files: Markdown plus images, Word with the
images **actually embedded**, and optionally PDF. Yuque charges for its own Word/PDF
export; this skill rebuilds the file from the public API instead, so no membership
and no third-party Yuque SDK is required.

## When to use

- The user pastes a `yuque.com` link and wants it saved, backed up, or shared.
- The user needs a Word/PDF copy for colleagues or for import into another platform.
- The user wants to migrate a Yuque document into Obsidian, Typora, or a Git repo.

Do not use this skill to republish someone else's content publicly. Download only
documents the user is allowed to access, and remind the user to respect the original
author's license.

## Scope: one document by default

By default the script fetches **only the document in the URL**. It reads the page's
embedded metadata (which includes `book_id`, required by the content API) but ignores
the table of contents, so no other document is requested. Whole-book export happens
only when the user explicitly asks for it and `--book` is passed.

## Usage

Requires Node.js 18.4+ (`engines` enforces a readable error below that; 20/22/24 recommended).
If `node -v` reports < 18, ask the user to upgrade via nvm or install the LTS from nodejs.org —
do not attempt to polyfill `fetch`.

**Dependencies:** when the skill was installed by copying/cloning the repo, run `npm install`
in the skill directory first (once). The CLI deliberately does not auto-install packages; if
dependencies are missing it exits with the exact command to run. `npx yuque-export` needs no setup.

```bash
npx yuque-export "<yuque-url>" [options]
# or, when running from a checkout (run `npm install` once beforehand)
node src/cli.js "<yuque-url>" [options]
```

| Option | Meaning |
|---|---|
| `-o, --out <dir>` | Output directory (default `./output`) |
| `--pdf` | Also render PDF via local Chrome/Edge/Chromium |
| `--md-only` | Export Markdown and images only |
| `--keep-html` | Keep the intermediate styled HTML |
| `-t, --token <val>` | Yuque cookie value (`_yuque_session`) for private documents; `YUQUE_COOKIE` env var also works and avoids leaving it in shell history |
| `--book` | Export the whole knowledge base (explicit opt-in) |
| `--limit <n>` | With `--book`, stop after the first n documents |
| `-h, --help` | Show help |

### Typical invocations

```bash
# single document with Word + PDF
npx yuque-export "https://www.yuque.com/user/book/doc" --pdf

# single document, Markdown only
npx yuque-export "https://www.yuque.com/user/book/doc" --md-only -o ./notes

# private document
npx yuque-export "https://www.yuque.com/user/book/doc" -t "<_yuque_session value>"

# whole book; use any public document URL inside it as the entry point
npx yuque-export "https://www.yuque.com/user/book/any-public-doc" --book --limit 10
```

## Output layout

```
<out>/
├── <title>.md          Markdown with relative image links
├── <title>.docx        Word, images embedded as base64
├── <title>.pdf         only with --pdf
└── img/<docId>/        downloaded images
```

Word headings use the built-in `Heading1`–`Heading6` styles, so re-importing the
`.docx` into Yuque or Word keeps the outline.

## How it works

1. Fetch the document page HTML and parse the embedded `decodeURIComponent(...)`
   payload, which holds `book.id`, `doc.slug`, and the title.
2. Call `/api/docs/<docSlug>?book_id=<bookId>&mode=markdown` and take the returned
   `sourcecode` (Yuque's lake-flavoured Markdown).
3. Strip inline `font` wrappers, download every remote image into `img/<docId>/`,
   and rewrite the links to relative paths.
4. Render Markdown to HTML, then to `.docx` with `html-to-docx`; a Chromium-based
   browser prints the PDF when `--pdf` is passed.

`book_id` is a knowledge-base identifier required by the single-document content
API. It does **not** trigger crawling — traversal is driven by the table of contents,
which is only consulted in `--book` mode.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `无法解析页面数据` | The link is not a public document. Pass `-t <cookie>` or ask the owner for access. |
| `HTTP 401` / `HTTP 404` on a document | That document is not public. Only publicly shared documents work anonymously. |
| Book mode reports `读取知识库失败` | Some books have no public home page. Use a public document URL from inside the book with `--book`. |
| `正文为空` | The document is a special widget (board, mind map, data sheet) with no Markdown body. |
| PDF skipped | No Chrome/Edge/Chromium found. Drop `--pdf`, keep the `.docx`. |
| Images missing | Some CDN images require auth or were deleted; the md keeps the original URL so nothing is silently lost. |

## Limits

- Yuque renders 画板 / 思维导图 / 数据表 as widgets, not images; those blocks become
  links or gaps in the export.
- Private and enterprise books require the user's own cookie and must respect their
  organization's data policy.
