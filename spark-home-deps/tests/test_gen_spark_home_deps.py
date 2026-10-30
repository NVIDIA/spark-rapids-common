# Copyright (c) 2026, NVIDIA CORPORATION.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET


SCRIPT = Path(__file__).resolve().parents[1] / 'gen-spark-home-deps.py'
SPEC = importlib.util.spec_from_file_location('gen_spark_home_deps', SCRIPT)
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class SparkHomeDepsTest(unittest.TestCase):
    def test_collect_jars_deduplicates_real_paths_and_excludes_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            jar_dir = Path(temp_dir)
            (jar_dir / 'spark.jar').touch()
            (jar_dir / 'skip-tests.jar').touch()
            (jar_dir / 'spark-link.jar').symlink_to('spark.jar')

            jars = GENERATOR.collect_jars([str(jar_dir), str(jar_dir)], ['tests'])

            self.assertEqual([str((jar_dir / 'spark.jar').resolve())], jars)

    def test_collect_jars_treats_directory_glob_characters_literally(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            jar_dir = Path(temp_dir) / 'spark[3]' / 'jars'
            jar_dir.mkdir(parents=True)
            jar = jar_dir / 'spark.jar'
            jar.touch()

            self.assertEqual([str(jar.resolve())], GENERATOR.collect_jars([str(jar_dir)], []))

    def test_generated_pom_uses_runtime_paths_and_consumer_version(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jar_dir = root / 'runtime & jars'
            jar_dir.mkdir()
            (jar_dir / 'spark & sql.jar').touch()
            project_pom = root / 'project.xml'
            project_pom.write_text(
                '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                '<parent><version>26.12.0-SNAPSHOT</version></parent></project>')
            template = root / 'template.xml'
            template.write_text(
                '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                '<version><!--PROJECT_VERSION_PLACEHOLDER--></version>'
                '<properties><!--SYSTEM_PROPERTIES_PLACEHOLDER--></properties>'
                '<dependencies><!--SYSTEM_DEPENDENCIES_PLACEHOLDER--></dependencies>'
                '<description>@SCALA_BINARY_VERSION@</description></project>')
            output = root / 'generated' / 'pom.xml'

            subprocess.run([
                sys.executable, str(SCRIPT), str(template),
                '--output-pom', str(output), '--project-pom', str(project_pom),
                '--scala-binary-version', '2.13', '--jar-dir', str(jar_dir),
            ], check=True, capture_output=True, text=True)

            namespace = {'m': 'http://maven.apache.org/POM/4.0.0'}
            pom = ET.parse(output).getroot()
            self.assertEqual('26.12.0-SNAPSHOT', pom.findtext('m:version', namespaces=namespace))
            self.assertEqual('2.13', pom.findtext('m:description', namespaces=namespace))
            self.assertEqual(str(jar_dir.resolve()),
                             pom.findtext('m:properties/m:spark.home.jar.dir.0', namespaces=namespace))
            dependency = pom.find('m:dependencies/m:dependency', namespace)
            self.assertEqual('system', dependency.findtext('m:scope', namespaces=namespace))
            self.assertEqual('${spark.home.jar.dir.0}/spark & sql.jar',
                             dependency.findtext('m:systemPath', namespaces=namespace))

    def test_missing_template_placeholder_fails_before_writing_pom(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            jar_dir = root / 'jars'
            jar_dir.mkdir()
            (jar_dir / 'spark.jar').touch()
            project_pom = root / 'project.xml'
            project_pom.write_text('<project xmlns="http://maven.apache.org/POM/4.0.0">'
                                   '<version>1.0</version></project>')
            template = root / 'template.xml'
            output = root / 'generated.xml'
            placeholders = (
                '@SCALA_BINARY_VERSION@',
                '<!--PROJECT_VERSION_PLACEHOLDER-->',
                '<!--SYSTEM_PROPERTIES_PLACEHOLDER-->',
                '<!--SYSTEM_DEPENDENCIES_PLACEHOLDER-->',
            )
            complete_template = ''.join(placeholders)

            for placeholder in placeholders:
                with self.subTest(placeholder=placeholder):
                    template.write_text(complete_template.replace(placeholder, ''))
                    result = subprocess.run([
                        sys.executable, str(SCRIPT), str(template),
                        '--output-pom', str(output), '--project-pom', str(project_pom),
                        '--scala-binary-version', '2.13', '--jar-dir', str(jar_dir),
                    ], capture_output=True, text=True)
                    self.assertNotEqual(0, result.returncode)
                    self.assertIn(f'Missing {placeholder}', result.stderr)
                    self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
