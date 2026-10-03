# Changelog

## [0.9.0](https://github.com/Enso-Team/enso-cli/compare/v0.8.1...v0.9.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* diagram primitive subcanvas commands and apply ops are removed. Use portal nodes for drill-down subcanvases.

### Features

* add --version (closes [#28](https://github.com/Enso-Team/enso-cli/issues/28)) ([e20752e](https://github.com/Enso-Team/enso-cli/commit/e20752ebb755bd74c1b817d7622d32f064431e60))
* add --version (closes [#28](https://github.com/Enso-Team/enso-cli/issues/28)) ([2072605](https://github.com/Enso-Team/enso-cli/commit/2072605a4c5e6f6789bc7ef314a430356e9f4e93))
* add 004 link relation sync to CLI ([9557989](https://github.com/Enso-Team/enso-cli/commit/95579893f27657d8f2e5d5074e4be3a3c0c0d349))
* add 004 link relation sync to CLI ([9e355a8](https://github.com/Enso-Team/enso-cli/commit/9e355a8650baf7a9eef35f14987261928e3283e3))
* align CLI with node-only subcanvas bridge (ADR-0011) ([34f59f6](https://github.com/Enso-Team/enso-cli/commit/34f59f6bd1701e035db28f7efcf56b790a8e3144))
* **auth:** link by reading the token file the app provisions ([0410a0d](https://github.com/Enso-Team/enso-cli/commit/0410a0dc6acd6fd100ee108120f959c179af17a8))
* **bridge:** the CLI and app name the contract they speak ([f0cc33d](https://github.com/Enso-Team/enso-cli/commit/f0cc33db07d6f5d68b2f7193ac6caccd71661925))
* **bridge:** the CLI checks the app's contract version and names the side to update on a mismatch ([d881a66](https://github.com/Enso-Team/enso-cli/commit/d881a664b3d211d879ee21c026dffc3b1b9c71bc))
* **canvas:** add batch canvas apply for agent diagram builds ([8d7d20e](https://github.com/Enso-Team/enso-cli/commit/8d7d20e3912973170eb227e4229669f8cc6cf93d))
* **canvas:** batch canvas apply for agent diagram builds ([c276230](https://github.com/Enso-Team/enso-cli/commit/c27623030ab375b262ad27bde481467f19e6181d))
* center pure-create canvas applies on the empty-Canvas home point ([ebd683e](https://github.com/Enso-Team/enso-cli/commit/ebd683e796764f24d46f7f2364c6cf3a68073267))
* **cli:** agents choose how Nodes and Link labels look, and linking uses only the token file ([#81](https://github.com/Enso-Team/enso-cli/issues/81)) ([23deba4](https://github.com/Enso-Team/enso-cli/commit/23deba4eb5a96db8397402924ca841f2d6cb019c))
* compile a canvas spec to a live Canvas with enso layout ([c6da264](https://github.com/Enso-Team/enso-cli/commit/c6da264421f4163d5da2d45482792e0c27d011c5)), closes [#18](https://github.com/Enso-Team/enso-cli/issues/18)
* enso check — standalone folder linter (closes [#20](https://github.com/Enso-Team/enso-cli/issues/20)) ([ac3105e](https://github.com/Enso-Team/enso-cli/commit/ac3105e012de3a9bf78cf0ba6af397a9833374af))
* enso check — standalone folder linter (closes [#20](https://github.com/Enso-Team/enso-cli/issues/20)) ([f9bb4f9](https://github.com/Enso-Team/enso-cli/commit/f9bb4f916c0cdbaae70f4f62a998a1b3754b62c2))
* enso layout — canvas spec to live canvas (closes [#18](https://github.com/Enso-Team/enso-cli/issues/18)) ([c75842d](https://github.com/Enso-Team/enso-cli/commit/c75842d94c2f5cbc775aefdc2ba693ea49ecc340))
* **errors:** the CLI names the bridge's refusals ([99485c6](https://github.com/Enso-Team/enso-cli/commit/99485c6170ea3204ba16045e98fed1ebabd41e1f))
* improve Enso workflow reliability ([2faaccb](https://github.com/Enso-Team/enso-cli/commit/2faaccb86179ec23e4cf2074d037462dfd61a91c))
* layout --spacing scales node-center distances for link-label room ([a6a5bff](https://github.com/Enso-Team/enso-cli/commit/a6a5bff585ff24e9df1028fee7730b0e4d5da1aa))
* layout --spacing scales node-center distances for link-label room ([353f000](https://github.com/Enso-Team/enso-cli/commit/353f00033ac04f993ee8baee450bdec809bdcdc2))
* link update moves an endpoint, mirroring the 1.3.1 bridge contract ([5c1a1ec](https://github.com/Enso-Team/enso-cli/commit/5c1a1ec8b48097629c8ad5826ee8cbed9dc6f9a1))
* link update moves an endpoint, mirroring the 1.3.1 bridge contract (closes [#37](https://github.com/Enso-Team/enso-cli/issues/37)) ([afff922](https://github.com/Enso-Team/enso-cli/commit/afff922c7ff2402d35452274eef9c50f65dc4a6d))
* **link:** add --from-note to 'link delete' ([2bc8cf0](https://github.com/Enso-Team/enso-cli/commit/2bc8cf05a488ee2026ad52c8e6ed9e1b91d4733a))
* **link:** add --from-note to 'link delete' ([a6a3301](https://github.com/Enso-Team/enso-cli/commit/a6a3301a08c6189fbf2012d46cbee339ee94ae03))
* node add (place existing Note) + canvas delete ([200eb5a](https://github.com/Enso-Team/enso-cli/commit/200eb5a50dab58fdb614074fe0f70e2f367c4669))
* node add (place existing Note) + canvas delete ([7aaa566](https://github.com/Enso-Team/enso-cli/commit/7aaa566006dd72bb71cb63efb50c72affca159c8))
* place compiled layouts where the app is looking ([bda7659](https://github.com/Enso-Team/enso-cli/commit/bda7659c42ddde906935b90e11547be78d18b496))
* place compiled layouts where the app is looking ([e0bd5bd](https://github.com/Enso-Team/enso-cli/commit/e0bd5bd0bcb31ce3276591d8ffe6de8453fd1aa7))
* redesign CLI workflows for reliable agents ([d13b11a](https://github.com/Enso-Team/enso-cli/commit/d13b11aa917f2e39764a46cdee5da429fa30c58e))
* **skill:** agents write the Notes, then draw Links that stand on wikilinks ([#70](https://github.com/Enso-Team/enso-cli/issues/70)) ([de5135e](https://github.com/Enso-Team/enso-cli/commit/de5135e9a0bc28bf17dab324a4f02b4befda9a6c))
* support positioned node creation ([3dcc813](https://github.com/Enso-Team/enso-cli/commit/3dcc81366ed89d36426d9028014c76363e5cafdd))


### Bug Fixes

* **auth:** a stale stored token relinks through the app's token file ([#66](https://github.com/Enso-Team/enso-cli/issues/66)) ([c3b2aca](https://github.com/Enso-Team/enso-cli/commit/c3b2aca9f199abc24712c8a872bce61e50be773d))
* canvas apply no longer builds offscreen on a fresh canvas ([f153460](https://github.com/Enso-Team/enso-cli/commit/f1534600990b366dbb519030a2ae359cb5b0b4f1))
* **ci:** avoid duplicate staging checks ([a80946e](https://github.com/Enso-Team/enso-cli/commit/a80946e8b13992a1ca4302372b91d94162afe0a6))
* **ci:** put CLI releases through staging review ([7199fa3](https://github.com/Enso-Team/enso-cli/commit/7199fa32889f42bf2c8f4730900903fff43037ea))
* **ci:** release version bumps through PRs ([f6b7128](https://github.com/Enso-Team/enso-cli/commit/f6b71280ad3b7b4165cc29be463f2b0fac542b8f))
* enforce the app's color grammar and name re-layout failures in enso layout ([d607558](https://github.com/Enso-Team/enso-cli/commit/d607558c38e0b27bf6bc4959b16ff0cb809e601e))
* keep re-layout guidance ahead of app error details ([8f25abb](https://github.com/Enso-Team/enso-cli/commit/8f25abbfcb6e957b31b60c17bf3a5bc31f59b43b))
* persist correct bridgeUrl ([581438d](https://github.com/Enso-Team/enso-cli/commit/581438d59808c3bce25f8e6b9185e00db414a262))
* persist correct bridgeUrl ([9c99063](https://github.com/Enso-Team/enso-cli/commit/9c99063110fe905df9b4aae9e06fbc2d3d438ef5))
* point check's unreadable-folder hint away from live canvases ([db40c9e](https://github.com/Enso-Team/enso-cli/commit/db40c9ee639ce0488d2c8a9e7dd19ecb59b34fdf))
* point check's unreadable-folder hint away from live canvases ([c04ccff](https://github.com/Enso-Team/enso-cli/commit/c04ccff2a5186f4574629a0fefce9e746cac1540))
* recover stale pairing lock (closes [#26](https://github.com/Enso-Team/enso-cli/issues/26)) ([86f4a96](https://github.com/Enso-Team/enso-cli/commit/86f4a9686795c8a1bb12980eb620787dc05205af))
* recover stale pairing locks with heartbeat-backed locking (closes [#26](https://github.com/Enso-Team/enso-cli/issues/26)) ([8f7d47a](https://github.com/Enso-Team/enso-cli/commit/8f7d47a818cc1885d0f02d5e087a0f42ec40db69))
* reject clear-label with sync-prose and show duplicate_link hint in pretty mode ([77cc986](https://github.com/Enso-Team/enso-cli/commit/77cc986e8f3c145fd50edffc9f1c21c569e69e35))
* retire divider CLI surface ([bd81ab6](https://github.com/Enso-Team/enso-cli/commit/bd81ab6750220462227e7f8e6189e71b898d0ca0))
* retire divider CLI surface ([d3a591c](https://github.com/Enso-Team/enso-cli/commit/d3a591c28192c04d57fa7ab16f1688981c7126c9))
* show duplicate_link hint when error envelope has text ([21f0434](https://github.com/Enso-Team/enso-cli/commit/21f0434879e88eb12bec83066b2bd8c6796e3b8c))
* unescape shell \n in inline content before bridge PUT ([a286213](https://github.com/Enso-Team/enso-cli/commit/a2862137a6a16d00f8059bb9a9c7dcaaa948f9d5))

## [0.8.1](https://github.com/Enso-Team/enso-cli/compare/v0.8.0...v0.8.1) (2026-10-04)

### Bug Fixes

* **cli:** explain blank and Note-derived Link labels ([#84](https://github.com/Enso-Team/enso-cli/pull/84)) ([fc82f33](https://github.com/Enso-Team/enso-cli/commit/fc82f33f89c61d907bce48b75d53a655e2b0a8ba))

## [0.8.0](https://github.com/Enso-Team/enso-cli/compare/v0.7.1...v0.8.0) (2026-09-29)


### Features

* **cli:** agents choose how Nodes and Link labels look, and linking uses only the token file ([#81](https://github.com/Enso-Team/enso-cli/issues/81)) ([23deba4](https://github.com/Enso-Team/enso-cli/commit/23deba4eb5a96db8397402924ca841f2d6cb019c))
* **skill:** agents write the Notes, then draw Links that stand on wikilinks ([#70](https://github.com/Enso-Team/enso-cli/issues/70)) ([de5135e](https://github.com/Enso-Team/enso-cli/commit/de5135e9a0bc28bf17dab324a4f02b4befda9a6c))

## [0.7.1](https://github.com/Enso-Team/enso-cli/compare/v0.7.0...v0.7.1) (2026-09-03)


### Bug Fixes

* **auth:** a stale stored token relinks through the app's token file ([#66](https://github.com/Enso-Team/enso-cli/issues/66)) ([c3b2aca](https://github.com/Enso-Team/enso-cli/commit/c3b2aca9f199abc24712c8a872bce61e50be773d))

## [0.7.0](https://github.com/Enso-Team/enso-cli/compare/v0.6.2...v0.7.0) (2026-09-02)


### Features

* **auth:** link by reading the token file the app provisions ([0410a0d](https://github.com/Enso-Team/enso-cli/commit/0410a0dc6acd6fd100ee108120f959c179af17a8))
* **bridge:** the CLI and app name the contract they speak ([f0cc33d](https://github.com/Enso-Team/enso-cli/commit/f0cc33db07d6f5d68b2f7193ac6caccd71661925))
* **bridge:** the CLI checks the app's contract version and names the side to update on a mismatch ([d881a66](https://github.com/Enso-Team/enso-cli/commit/d881a664b3d211d879ee21c026dffc3b1b9c71bc))
* **errors:** the CLI names the bridge's refusals ([99485c6](https://github.com/Enso-Team/enso-cli/commit/99485c6170ea3204ba16045e98fed1ebabd41e1f))


### Bug Fixes

* **ci:** avoid duplicate staging checks ([a80946e](https://github.com/Enso-Team/enso-cli/commit/a80946e8b13992a1ca4302372b91d94162afe0a6))
* **ci:** put CLI releases through staging review ([7199fa3](https://github.com/Enso-Team/enso-cli/commit/7199fa32889f42bf2c8f4730900903fff43037ea))
* **ci:** release version bumps through PRs ([f6b7128](https://github.com/Enso-Team/enso-cli/commit/f6b71280ad3b7b4165cc29be463f2b0fac542b8f))
* persist correct bridgeUrl ([581438d](https://github.com/Enso-Team/enso-cli/commit/581438d59808c3bce25f8e6b9185e00db414a262))
* persist correct bridgeUrl ([9c99063](https://github.com/Enso-Team/enso-cli/commit/9c99063110fe905df9b4aae9e06fbc2d3d438ef5))
