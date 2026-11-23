# Changelog

All notable changes to the `toolbox` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `toolbox@<version>`.

## [Unreleased]

## [1.5.0] - 2026-11-23

### Added
- JWT signing: an **Header** field (JSON) for extra entries such as `kid`, `typ` or `x5t`; `alg` is the one chosen in the menu and comes first.
- JWT signing with a **private key**: RS256/384/512, PS256/384/512 and ES256/384/512 besides HS256/384/512. **Open file…** reads the key from a `.key`/`.pem` file: PEM PKCS#8 (`BEGIN PRIVATE KEY`), PKCS#1 (`BEGIN RSA PRIVATE KEY`), SEC1 (`BEGIN EC PRIVATE KEY`) or JWK. A key encrypted with a password is reported with the command to decrypt it.
- JWT verification: **Open file…** reads the public key from a `.pub` file: PEM SPKI (`BEGIN PUBLIC KEY`), PKCS#1 (`BEGIN RSA PUBLIC KEY`), an OpenSSH line (`ssh-rsa …`, `ecdsa-sha2-nistp256/384/521 …`) or JWK. Clear errors for a private key given instead of the public one and for a key that does not fit the algorithm.
- Keys and secrets never leave the browser.

## [1.4.0] - 2026-11-17

### Added
- **Mock**: the Toolbox is also an optional add-on of the Mock section (Kelbo ≥ 2.45, Mock ≥ 1.1). In the dialog of a route, *Edit in the Toolbox* opens the JSON body in the JSON tab with a bar *From Shop · GET /users/:id* and **Save to the response**, which writes the edited JSON back into the route; *Import from the Toolbox* puts the JSON of the JSON tab into the body of the route being edited (also a new one).
- The last JSON of the JSON tab is kept when the page is reloaded.

## [1.3.0] - 2026-11-16

### Changed
- JSON shown like the responses of the HTTP section (Kelbo ≥ 2.43): the formatted result is a coloured tree with ▾ to close a level, Alt+click for the ones inside, *Expand* and *Collapse*; minified, *To string* and *From string* results are coloured text; the input — and the Compare inputs in JSON mode — are coloured while you type, also when the JSON is on one line or not valid yet. The Text/Tree switch is gone: the tree is the formatted view.

## [1.2.0] - 2026-11-16

### Added
- **JSON** and **Compare** on the response of a request in the HTTP section: the Toolbox is an *optional add-on* of HTTP (Kelbo ≥ 2.42, HTTP ≥ 1.2). **JSON** opens a JSON response in the JSON tab, formatted; **Compare** puts the response on the right of the Compare tab and moves the previous one to the left, so two sends in a row are compared (by JSON path when both are JSON). Without the HTTP section the Toolbox works as before.
- Other sections can open the Toolbox with `{ json }` or `{ compare }` as well as `{ jwt }`.

## [1.1.1] - 2026-11-15

### Fixed
- JWT: the "Create a signed token" section was squeezed into a 14px column, one word per line (a style of the Compare tab used the same class name).

## [1.1.0] - 2026-11-15

### Added
- **JSON** tab: format (indent 2, 4 or tab), minify, sorted keys, to and from a JSON string (escape and unescape), as text or as a collapsible **tree** with types in colour; validated as you type, an error shows the line and column with the point marked in the text; *Use* puts the result back as the input.
- **Compare** tab: two texts side by side or in a unified view, differences line by line (Myers' algorithm, as `git diff`) with the changed words highlighted inside the lines, unchanged stretches folded around 3 lines of context, ignore spaces or case, swap. In **JSON** mode the values are compared and not the formatting (key order and spaces don't count), with the list of the changed paths (`$.deps.express`: changed, added, removed).

## [1.0.0] - 2026-11-14

### Added
- **Toolbox** in the right bar (it can be moved to a tab or the header), with four tabs; everything is computed in the browser, nothing is sent anywhere.
- **JWT**: paste a token (also with `Bearer `) to see header and payload, the algorithm and `exp`/`iat`/`nbf` with how long ago or how long to go (valid, expired, not yet valid). **Tokens of the HTTP client**: the user types of the HTTP client sections that have a token in memory are listed, and one click loads it (Kelbo 2.35 services; the value is read only with the vault unlocked, the master password is asked when needed). **Signature check** with the shared secret (HS256/384/512) or the public key as PEM or JWK (RS, PS, ES 256/384/512); **create a signed token** (HS) from header and payload JSON.
- **Encode / decode**: Base64, Base64URL, URL encoding, HTML entities, hex, `\u` Unicode escapes and JSON strings, both ways, with swap.
- **Hash** of a text or a file: MD5, SHA-1, SHA-256, SHA-384, SHA-512, as hex or Base64, and HMAC with a key (SHA family).
- **Generate**: UUID v4 and v7, random strings (letters and digits, hex, with symbols) of the chosen length, and timestamp conversions (Unix seconds or milliseconds, ISO) to UTC, local time and relative time.
