# Spark installation jar dependencies

`gen-spark-home-deps.py` renders a consumer-owned Maven POM template into a POM
whose dependencies point at the jars of a Spark installation. Consumers pass
one or more `--jar-dir` arguments, such as `/databricks/jars`, and choose the
output location and Scala binary version. The build uses the generated POM
locally; the script does not install jars into Maven or download them.

Consumers should check in a copy of this script pinned to a full commit of
this repository. Each consumer keeps its own POM template, Maven profiles,
and build entry point, since their parent coordinates and reactor modules
differ. Updating the copy is an explicit source change.

Run `python3 -m unittest discover -s spark-home-deps/tests` to test the
generator.
