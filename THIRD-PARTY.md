# Third-party notices

inphub lite itself is AGPL-3.0 (see `LICENSE`). It has no runtime
`dependencies`, but `tools/build.mjs` inlines the libraries below into
`public/assets/js/app-*.js`, so they are distributed with every copy of the app
and their notices travel with it. Each is compatible with AGPL-3.0.

The build tools (esbuild, TypeScript, `@types/node`) are not listed: they run at
build time and no part of them ends up in the bundle.

## Chart.js — MIT

Copyright (c) 2014-2022 Chart.js Contributors
<https://github.com/chartjs/Chart.js>

## marked — MIT

Copyright (c) 2018+ MarkedJS
Copyright (c) 2011-2018 Christopher Jeffrey
<https://github.com/markedjs/marked>

## marked-footnote — MIT

Copyright (c) 2023 Ryan Chen
<https://github.com/bent10/marked-extensions>

## DOMPurify — MPL-2.0 OR Apache-2.0

Copyright (c) Dr.-Ing. Mario Heiderich, Cure53
<https://github.com/cure53/DOMPurify>

Dual-licensed. inphub lite takes it under **Apache-2.0**, which is compatible
with AGPL-3.0. (MPL-2.0 would also serve; the election is recorded here so the
choice is not left to the reader.)

---

Full licence texts ship with each package under `node_modules/<name>/LICENSE`
and are available at the URLs above.
