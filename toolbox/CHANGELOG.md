# Changelog

All notable changes to the `toolbox` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `toolbox@<version>`.

## [Unreleased]

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
