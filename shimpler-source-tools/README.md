# Shimpler source tools

These four Apache-licensed Python modules are the source-selection core shared by
Spark RAPIDS builds. They parse `shim.source.inherits` from Maven profiles, parse
shim selectors, resolve the nearest source variant, and materialize the selected
files. The modules use only Python 2.7/Jython-compatible standard-library APIs.

Use one selector for a source shared by several inheritance roots:

```json
{"spark":["330","350","400","420"],"includeDescendantShims":true}
```

The source applies at each listed root and its descendants. A nearer source
variant for a target takes precedence. The earlier `{"spark":{"introduced":
"330"}}` form remains readable during migration.

The consumer repository owns its Maven/Ant entry point, build-version discovery,
and release-profile policy. It should pin a reviewed version of these files and
make them available on the build script's Python path. Builds must not fetch
`main` or download these files during `generate-sources`.

For now, consumers can vendor these four files unchanged. Before updating a pin,
compare each vendored file byte-for-byte with this directory, run the consumer's
source-set parity check across every supported buildver, and run its clean
multi-shim build. This directory intentionally contains no NVIDIA-private
build profiles or source paths.

Run the standalone tests with:

```bash
python3 -m unittest discover -s shimpler-source-tools/tests
```
