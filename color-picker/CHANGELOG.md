# Changelog

All notable changes to the `color-picker` extension. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); releases are tagged `color-picker@<version>`.

## [Unreleased]

## [1.0.0] - 2026-11-13

### Added
- **Color picker** in the right bar (Kelbo 2.31 positions; it can be moved to a tab or the header): saturation/brightness square (also with the arrow keys), hue and transparency sliders, a field that reads HEX, `rgb()`, `hsl()`, `oklch()` and CSS color names, and the browser's **eyedropper** to pick any pixel of the screen (Chrome, Edge).
- **Formats to copy**: HEX, RGB, HSL, OKLCH and a CSS variable, each with its copy button; the colors picked or copied stay in the **recent** list (in this browser).
- **Shades 50–950** of the color in OKLCH (same hue, lightness like the Tailwind scales, chroma kept inside sRGB), with the color itself on its nearest step; copy as CSS variables or save as a palette. **Harmonies**: complementary, analogous, triadic, split complementary, tetradic.
- **Contrast** (WCAG 2): text on a chosen background with a live sample, the ratio, AA/AAA for normal and large text and for components, and the closest color with the same hue that passes AA.
- **Palettes** saved in `config.json` (`colorPalettes`), general or of a project, with an *Export* checkbox (merge import adds the new ones): add the current color, remove colors, rename, move to a project, copy as CSS variables. A project's palettes are listed among its links in the Projects panel.
- **Colors of a project**: the colors written in its files (CSS, SCSS, Less, HTML, templates, components, JSON, SVG; `node_modules`, `dist`, builds and minified files left out), most used first, with the CSS/SCSS/Less variables that define them and the files and lines where they appear; save them as a palette.
- **Dashboard widget** with the project's colors and palettes (a click copies the color), **MCP tools** `color_picker_palettes` and `color_picker_project_colors` (read-only).
