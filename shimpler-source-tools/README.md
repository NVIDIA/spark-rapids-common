# Shimpler source tools

These four Apache-licensed Python modules are the source-selection core shared by
Spark RAPIDS builds. They parse `shim.source.inherits` from Maven profiles, parse
shim selectors, resolve the nearest source variant, and materialize the selected
files. The modules use only Python 2.7/Jython-compatible standard-library APIs.

Use one selector form for exact targets and inherited roots:

```json
{"spark":["330","331"],"carryForward":"none"}
{"spark":["404"],"carryForward":"sameMinor"}
{"spark":["330","350","400","420"],"carryForward":"all"}
```

`none` applies only to the listed targets. `sameMinor` also applies to their
descendants in the same Spark major/minor release line; for example, 404 reaches
405 but not 411, even if 411 inherits 404. `all` applies to every descendant.
All scopes follow the explicit `shim.source.inherits` graph, and a nearer
source variant takes precedence. The major/minor line comes from the first two
digits of the three-digit Spark buildver. Scalar and object-form Spark selectors
and the old `includeDescendantShims` field are not supported.

A patch release normally adds a graph edge to the preceding patch and an exact
version-identity source; `sameMinor` sources then arrive without annotation
edits. A new minor line can also inherit its predecessor as a starting point:
keep `all` only where source compatibility is intended across that boundary,
use `sameMinor` for sources that must stop, and add nearer variants for changed
APIs. The graph remains necessary to define that starting point and precedence.

The consumer repository owns its Maven/Ant entry point, build-version discovery,
and release-profile policy. It should pin a reviewed version of these files and
make them available on the build script's Python path. Builds must not fetch
`main` or download these files during `generate-sources`.

For now, consumers can vendor these four files unchanged. Before updating a pin,
compare each vendored file byte-for-byte with this directory, run the consumer's
source-set parity check across every supported buildver, and run its clean
multi-shim build. This directory intentionally contains no NVIDIA-private
build profiles or source paths.

Make shared behavior changes here first. Update consumer copies only after the
common change has been reviewed and committed, then pin that exact common commit.

Run the standalone tests with:

```bash
python3 -m unittest discover -s shimpler-source-tools/tests
```
