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

The consumer template must contain these insertion points. The generator fails
if any are missing:

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>spark-runtime-deps_@SCALA_BINARY_VERSION@</artifactId>
  <version><!--PROJECT_VERSION_PLACEHOLDER--></version>
  <properties><!--SYSTEM_PROPERTIES_PLACEHOLDER--></properties>
  <dependencies><!--SYSTEM_DEPENDENCIES_PLACEHOLDER--></dependencies>
</project>
```

For example, after saving that template as `runtime-deps/pom.xml.template`:

```sh
python3 spark-home-deps/gen-spark-home-deps.py runtime-deps/pom.xml.template \
  --output-pom runtime-deps/pom.xml --project-pom pom.xml \
  --scala-binary-version 2.13 --jar-dir "$SPARK_HOME/jars"
```

Run `python3 -m unittest discover -s spark-home-deps/tests` to test the
generator.
