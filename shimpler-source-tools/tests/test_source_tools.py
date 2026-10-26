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

from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shimpler_source_graph import load_source_graph, source_lineage, validate_source_graph
from shimpler_source_generator import generate_sources
from shimpler_source_resolver import resolve_sources, scan_module_sources


class SourceToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.module = self.root / 'module'
        pom = self.root / 'pom.xml'
        pom.write_text('''<project xmlns="http://maven.apache.org/POM/4.0.0">
          <profiles>
            <profile><id>release400</id><properties><buildver>400</buildver></properties></profile>
            <profile><id>release401</id><properties><buildver>401</buildver>
              <shim.source.inherits>400</shim.source.inherits></properties></profile>
          </profiles></project>''')
        self.graph = load_source_graph(str(pom))

    def source(self, owner, name, selector):
        path = self.module / 'src' / 'main' / ('spark' + owner) / 'scala' / 'pkg' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('/*** spark-rapids-shim-json-lines\n' + selector +
                        '\nspark-rapids-shim-json-lines ***/\npackage pkg\nclass Example\n')
        return path

    def test_inherited_source_and_exact_override(self):
        base = self.source('400', 'A.scala', '{"spark": {"introduced": "400"}}')
        override = self.source('401', 'A.scala', '{"spark": "401"}')
        variants, skipped = scan_module_sources(str(self.module), self.graph)
        self.assertEqual(skipped, [])
        logical = 'src/main/scala/pkg/A.scala'
        self.assertEqual(resolve_sources(self.graph, variants, '400')[logical].physical_path,
                         str(base))
        self.assertEqual(resolve_sources(self.graph, variants, '401')[logical].physical_path,
                         str(override))

    def test_generation_uses_inherited_source(self):
        base = self.source('400', 'B.scala', '{"spark": {"introduced": "400"}}')
        generated = self.root / 'generated'
        selected = generate_sources(str(self.module), str(generated), self.graph, '401')
        logical = 'src/main/scala/pkg/B.scala'
        self.assertEqual(selected[logical].physical_path, str(base))
        self.assertEqual((generated / 'main' / 'scala' / 'pkg' / 'B.scala').resolve(), base)

    def test_generation_ignores_known_inactive_introduction(self):
        self.source('330', 'Old.scala', '{"spark": {"introduced": "330"}}')
        current = self.source('400', 'Current.scala', '{"spark": "400"}')
        generated = self.root / 'generated'
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330'):
            generate_sources(str(self.module), str(generated), self.graph, '400')
        selected = generate_sources(str(self.module), str(generated), self.graph, '400',
                                    set(self.graph) | {'330'})
        self.assertEqual({item.physical_path for item in selected.values()}, {str(current)})

    def test_branching_lineage_and_exact_only_source(self):
        graph = {'400': None, '401': '400', '402': '400'}
        base = self.source('400', 'Base.scala', '{"spark": {"introduced": "400"}}')
        only = self.source('401', 'Only.scala', '{"spark": {"only": "401"}}')
        variants, skipped = scan_module_sources(str(self.module), graph)
        self.assertFalse(skipped)
        self.assertEqual(source_lineage(graph, '402'), ['402', '400'])
        self.assertEqual({source.physical_path for source in
                          resolve_sources(graph, variants, '401').values()}, {str(base), str(only)})
        self.assertEqual({source.physical_path for source in
                          resolve_sources(graph, variants, '402').values()}, {str(base)})

    def test_rejects_missing_parent_and_cycle(self):
        with self.assertRaisesRegex(ValueError, 'Source parent 400 of 401 is not a build target'):
            validate_source_graph({'401': '400'})
        with self.assertRaisesRegex(ValueError, 'Source inheritance cycle'):
            validate_source_graph({'400': '401', '401': '400'})

    def test_ambiguity_preserves_previous_generated_sources(self):
        self.source('400', 'A.scala', '{"spark": "401"}')
        self.source('401', 'A.scala', '{"spark": "401"}')
        generated = self.root / 'generated'
        previous = generated / 'main' / 'scala' / 'pkg' / 'Previous.scala'
        previous.parent.mkdir(parents=True)
        previous.write_text('previous')
        with self.assertRaisesRegex(ValueError, 'Ambiguous shim sources'):
            generate_sources(str(self.module), str(generated), self.graph, '401')
        self.assertEqual(previous.read_text(), 'previous')

    def test_generation_removes_stale_sources(self):
        self.source('400', 'A.scala', '{"spark": "400"}')
        generated = self.root / 'generated'
        stale = generated / 'main' / 'scala' / 'pkg' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        generate_sources(str(self.module), str(generated), self.graph, '400')
        self.assertFalse(stale.exists())


if __name__ == '__main__':
    unittest.main()
