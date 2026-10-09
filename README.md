# dsh-document

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin: edit `.doc`,
`.docx` and `.odt` with LibreOffice's own editor (menus, toolbars, sidebar, dialogs) in the center
of DSH, with the AI chat beside it. Built on
[dsh-editor-template](https://github.com/TzuHwang/dsh-editor-template).

**Status: skeleton.** The plugin registers its document engine and DSH opens those files in it;
the engine is a placeholder until LibreOffice is wired in.

## How it works

- The template's editor fills the center and puts DSH's own conversation in the right sidebar.
  It edits text only; this plugin registers a **self-managed engine** for `doc`, `docx` and `odt`,
  which reads, saves and watches its files itself.
- The engine runs LibreOffice compiled to WebAssembly ([ZetaOffice](https://zetaoffice.net) through
  [zetajs](https://github.com/allotropia/zetajs)) in an iframe the plugin serves with
  `Document-Isolation-Policy: isolate-and-credentialless`. That isolates the iframe alone, so
  LibreOffice gets the `SharedArrayBuffer` its threads need while DSH's page stays as it is.
- The LibreOffice runtime (about 50 MB) and a CJK font are downloaded from their CDNs the first
  time a document opens, then cached by the browser. Installing the plugin downloads nothing extra.
- The AI edits documents through tools that drive the open LibreOffice instance (UNO), so changes
  show live and can be undone.

Requirements: the DSH web app in a Chromium browser (Chrome or Edge; `Document-Isolation-Policy`
is Chromium-only), and network access to the CDNs on first use.

## Develop

Clone [dsh-editor-template](https://github.com/TzuHwang/dsh-editor-template) next to this
repository (`../dsh-editor-template`, or set `DSH_EDITOR_TEMPLATE`): until the template releases
the self-managed engine API, `@dsh-editor/core` links to that checkout.

```sh
pnpm install
pnpm typecheck
pnpm build                 # lib/host.js, lib/client.js
pnpm smoke                 # builds both, installs them into a fresh DSH, checks in Edge
pnpm dev:patch             # .dev/dev.patch.yml: both checkouts, editor on
dsh --profile web --patch .dev/dev.patch.yml
```

`dsh` options (`--profile`, `--patch`) go before app options (`--port`, `--no-open`). The smoke
test uses the DSH version pinned in `package.json#dshVersion`, from this checkout's `.dev/`, the
template checkout's, or a fresh install.

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
