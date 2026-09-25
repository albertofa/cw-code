# Application branding resources

`icon.ico` is generated from the selected Console C master in
`design/brand/assets/cw-code.ico`. Electron uses it at runtime; electron-builder
uses it for the executable and NSIS installer/uninstaller. `extraResources`
copies this directory to `resources/branding` in the packaged application.

Project and font license notices are included alongside the icon. To refresh
the icon and renderer SVG after an approved brand edit, run
`python design/brand/generate.py` from the repository root.
