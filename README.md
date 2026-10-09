# dsh-document

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin: edit `.doc`,
`.docx` and `.odt` with LibreOffice's own editor (menus, toolbars, sidebar, dialogs) in the center
of DSH, with the AI chat beside it. Built on
[dsh-editor-template](https://github.com/TzuHwang/dsh-editor-template).

**Status: early development.** Documents open in LibreOffice in the center, save back to their
files, and the AI reads and edits them with its own tools.

## How it works

- The template's editor fills the center and puts DSH's own conversation in the right sidebar.
  It edits text only; this plugin registers a **self-managed engine** for `doc`, `docx` and `odt`,
  which reads, saves and watches its files itself.
- The engine runs LibreOffice compiled to WebAssembly ([ZetaOffice](https://zetaoffice.net) through
  [zetajs](https://github.com/allotropia/zetajs)) in an iframe the plugin serves with
  `Document-Isolation-Policy: isolate-and-credentialless`. That isolates the iframe alone, so
  LibreOffice gets the `SharedArrayBuffer` its threads need while DSH's page stays as it is.
- The LibreOffice runtime and a CJK font (about 60 MB together) are downloaded from their CDNs the first
  time a document opens, then cached by the browser. Installing the plugin downloads nothing extra.
- Saving: after a pause in editing, when focus leaves the editor (e.g. for the chat), on Ctrl+S
  or LibreOffice's Save, and when the tab closes, LibreOffice exports the document in the file's
  own format (`.doc` stays Word 97) and the plugin's host route writes it, guarded by the version
  last read. A change on disk reloads a clean document and is a conflict prompt while edits are
  pending, so an AI write is never overwritten silently.
- LibreOffice commands that act outside the document's file (open, new, close, save as,
  export, print, mail, other windows) are disabled; Save writes the file. The AI context follows
  LibreOffice's cursor and selection: the selected text, and the paragraph standing in for the
  line number.
- LibreOffice's interface is in English: the ZetaOffice CDN build ships only the en-US language
  pack (editing and displaying CJK text works). A self-hosted build with more language packs can
  be configured below.
- The AI has two tools. `document_read` returns the document as numbered blocks (paragraphs with
  their style, tables), unsaved changes included. `document_edit` replaces text, inserts and
  deletes paragraphs, sets paragraph styles and bold / italic / underline: in the user's
  LibreOffice, so the change shows at once, as one undo step (one Ctrl+Z reverts it), all or
  nothing, then saved to the file. A document that is not open opens in the center first. The
  tools need the session open in DSH in the browser with Editor mode on; the host reaches the page
  through a server-sent-events stream of its own.
- Settings → Document editor: ask before each AI edit (on by default).

Requirements: the DSH web app in a Chromium browser (Chrome or Edge; `Document-Isolation-Policy`
is Chromium-only), and network access to the CDNs on first use.

## Configuration

The plugin's settings (its `dsh-document` row in the profile patch) say where the editor page loads
LibreOffice from. Point them at your own copies to pin versions or work offline:

```yaml
- id: dsh-document
  config:
    zetaofficeUrl: https://cdn.zetaoffice.net/zetaoffice_latest/   # soffice.js / .wasm / .data
    zetajsUrl: https://cdn.jsdelivr.net/npm/zetajs@1.2.0/source/
    cjkFontUrl: https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf   # '' for none
    confirmEdits: true   # ask before each AI edit (Settings → Document editor changes it at once)
```

The ZetaOffice CDN publishes only `zetaoffice_latest`, so by default LibreOffice updates with it.

## Develop

Clone [dsh-editor-template](https://github.com/TzuHwang/dsh-editor-template) next to this
repository (`../dsh-editor-template`, or set `DSH_EDITOR_TEMPLATE`): until the template releases
the self-managed engine API, `@dsh-editor/core` links to that checkout.

```sh
pnpm install
pnpm test                  # unit tests
pnpm typecheck
pnpm build                 # lib/host.js, lib/client.js, lib/editor/
pnpm smoke                 # builds both, installs them into a fresh DSH, checks in Edge
pnpm test-site             # a DSH of its own to try the plugin by hand (see below)
pnpm dev:patch             # .dev/dev.patch.yml: both checkouts, editor on
dsh --profile web --patch .dev/dev.patch.yml
```

`dsh` options (`--profile`, `--patch`) go before app options (`--port`, `--no-open`). The smoke
test uses the DSH version pinned in `package.json#dshVersion`, from this checkout's `.dev/`, the
template checkout's, or a fresh install.

`pnpm test-site` serves DSH on port 7790 (`TEST_SITE_PORT`) with a home of its own in
`.dev/test-site/` (your own DSH home is not touched), both checkouts installed, Editor mode on, and
sample documents in its workspace; open the printed URL in Chrome or Edge. Sign-in, settings and
workspace files are kept between runs: `--no-build` skips the builds, `--reset` starts over.

## Release and install

DSH loads built files: commit `lib/` on a tag, then print the install command, which installs
the template's packages top level next to this project (DSH profiles refuse git dependencies of
installed packages):

```sh
pnpm install-command --project "github:TzuHwang/dsh-document#<tag>"
```

## License

MIT. LibreOffice is under the MPL-2.0; ZetaOffice, loaded at runtime from its CDN, has its own
terms of use (to be reviewed before the first release).
