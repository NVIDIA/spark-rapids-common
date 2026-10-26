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
import os
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shimpler_source_graph import load_source_graph, source_lineage, validate_source_graph
from shimpler_source_generator import generate_sources
from shimpler_source_resolver import (candidate_inherited_sources, resolve_sources,
                                      scan_module_sources, validate_legacy_shadow)
from shimpler_source_selectors import parse_selector_line


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
        base = self.source('400', 'A.scala',
                           '{"spark":["400"],"includeDescendantShims":true}')
        override = self.source('401', 'A.scala',
                               '{"spark":["401"],"includeDescendantShims":false}')
        variants, skipped = scan_module_sources(str(self.module), self.graph)
        self.assertEqual(skipped, [])
        logical = 'src/main/scala/pkg/A.scala'
        self.assertEqual(resolve_sources(self.graph, variants, '400')[logical].physical_path,
                         str(base))
        self.assertEqual(resolve_sources(self.graph, variants, '401')[logical].physical_path,
                         str(override))

    def test_descendant_list_spans_roots_and_respects_nearer_override(self):
        graph = {'330': None, '331': '330', '350': None, '351': '350'}
        shared = self.source('330', 'Shared.scala',
                             '{"spark":["330","350"],"includeDescendantShims":true}')
        override = self.source('351', 'Shared.scala',
                               '{"spark":["351"],"includeDescendantShims":false}')
        variants, skipped = scan_module_sources(str(self.module), graph)
        self.assertFalse(skipped)
        logical = 'src/main/scala/pkg/Shared.scala'
        for target in ('330', '331', '350'):
            self.assertEqual(resolve_sources(graph, variants, target)[logical].physical_path,
                             str(shared))
        self.assertEqual(resolve_sources(graph, variants, '351')[logical].physical_path,
                         str(override))

    def test_exact_list_does_not_include_descendants(self):
        graph = {'330': None, '331': '330', '350': None, '351': '350'}
        source = self.source('330', 'Exact.scala',
                             '{"spark":["330","350"],"includeDescendantShims":false}')
        variants, skipped = scan_module_sources(str(self.module), graph)
        self.assertFalse(skipped)
        logical = 'src/main/scala/pkg/Exact.scala'
        for target in ('330', '350'):
            self.assertEqual(resolve_sources(graph, variants, target)[logical].physical_path,
                             str(source))
        for target in ('331', '351'):
            self.assertNotIn(logical, resolve_sources(graph, variants, target))

    def test_descendant_list_requires_true_flag_and_known_unique_roots(self):
        graph = {'330': None, '350': None}
        valid = parse_selector_line(
            '{"spark":["330","350"],"includeDescendantShims":true,"delta":"test"}', graph)
        self.assertEqual(valid.kind, 'descendants')
        self.assertEqual(valid.targets, ('330', '350'))
        self.assertEqual(valid.other_components, {'delta': 'test'})
        for invalid, message in (
                ('{"spark":[],"includeDescendantShims":true}', 'nonempty'),
                ('{"spark":["330","330"],"includeDescendantShims":true}', 'Duplicate'),
                ('{"spark":["330","999"],"includeDescendantShims":true}', 'Unknown'),
                ('{"spark":["330","350"]}', 'includeDescendantShims boolean'),
                ('{"spark":["330"],"includeDescendantShims":1}',
                 'includeDescendantShims boolean'),
                ('{"spark":"330"}', 'target list'),
                ('{"spark":{"introduced":"330"}}', 'target list'),
                ('{"spark":{"only":"330"}}', 'target list')):
            with self.subTest(selector=invalid), self.assertRaisesRegex(ValueError, message):
                parse_selector_line(invalid, graph)

    def test_generation_uses_inherited_source(self):
        graph = {'330': None, '331': '330', '400': None, '401': '400'}
        base = self.source('400', 'B.scala',
                           '{"spark":["330","400"],"includeDescendantShims":true}')
        generated = self.root / 'generated'
        selected = generate_sources(str(self.module), str(generated), graph, '401')
        logical = 'src/main/scala/pkg/B.scala'
        self.assertEqual(selected[logical].physical_path, str(base))
        self.assertEqual((generated / 'main' / 'scala' / 'pkg' / 'B.scala').resolve(), base)

    def test_generation_with_relative_module_root_has_readable_links(self):
        base = self.source('400', 'B.scala',
                           '{"spark":["400"],"includeDescendantShims":false}')
        generated = self.root / 'generated'
        previous = os.getcwd()
        try:
            os.chdir(str(self.root))
            generate_sources('module', str(generated), self.graph, '400')
        finally:
            os.chdir(previous)
        link = generated / 'main' / 'scala' / 'pkg' / 'B.scala'
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), base)
        self.assertIn('class Example', link.read_text())

    def test_closed_exact_membership_can_be_inherited(self):
        self.source('400', 'Closed.scala',
                    '{"spark":["400","401"],"includeDescendantShims":false}')
        variants, _ = scan_module_sources(str(self.module), self.graph)
        candidates, non_inheritable = candidate_inherited_sources(self.graph, variants)
        self.assertFalse(non_inheritable)
        self.assertEqual(candidates[0].selectors[0].kind, 'descendants')
        self.assertEqual(candidates[0].selectors[0].targets, ('400',))
        self.assertEqual(validate_legacy_shadow(self.graph, variants), ())

    def test_removed_source_keeps_exact_membership(self):
        graph = {'400': None, '401': '400', '402': '401'}
        source = self.source('400', 'Removed.scala',
                             '{"spark":["400","401"],"includeDescendantShims":false}')
        variants, _ = scan_module_sources(str(self.module), graph)
        candidates, non_inheritable = candidate_inherited_sources(graph, variants)
        self.assertEqual(non_inheritable, (str(source),))
        self.assertEqual(candidates[0].selectors[0].kind, 'exact')
        self.assertEqual(validate_legacy_shadow(graph, variants), (str(source),))
        self.assertFalse(resolve_sources(graph, candidates, '402'))

    def test_target_specific_logical_path_keeps_exact_membership(self):
        source = self.source('400', 'spark400/Specific.scala',
                             '{"spark":["400","401"],"includeDescendantShims":false}')
        variants, _ = scan_module_sources(str(self.module), self.graph)
        candidates, non_inheritable = candidate_inherited_sources(self.graph, variants)
        self.assertEqual(non_inheritable, (str(source),))
        self.assertEqual(candidates[0].selectors[0].kind, 'exact')
        self.assertEqual(validate_legacy_shadow(self.graph, variants), (str(source),))

    def test_generation_ignores_known_inactive_introduction(self):
        self.source('330', 'Old.scala',
                    '{"spark":["330"],"includeDescendantShims":true}')
        current = self.source('400', 'Current.scala',
                              '{"spark":["400"],"includeDescendantShims":false}')
        generated = self.root / 'generated'
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330'):
            generate_sources(str(self.module), str(generated), self.graph, '400')
        selected = generate_sources(str(self.module), str(generated), self.graph, '400',
                                    set(self.graph) | {'330'})
        self.assertEqual({item.physical_path for item in selected.values()}, {str(current)})

    def test_branching_lineage_and_exact_only_source(self):
        graph = {'400': None, '401': '400', '402': '400'}
        base = self.source('400', 'Base.scala',
                           '{"spark":["400"],"includeDescendantShims":true}')
        only = self.source('401', 'Only.scala',
                           '{"spark":["401"],"includeDescendantShims":false}')
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
        self.source('400', 'A.scala', '{"spark":["401"],"includeDescendantShims":false}')
        self.source('401', 'A.scala', '{"spark":["401"],"includeDescendantShims":false}')
        generated = self.root / 'generated'
        previous = generated / 'main' / 'scala' / 'pkg' / 'Previous.scala'
        previous.parent.mkdir(parents=True)
        previous.write_text('previous')
        with self.assertRaisesRegex(ValueError, 'Ambiguous shim sources'):
            generate_sources(str(self.module), str(generated), self.graph, '401')
        self.assertEqual(previous.read_text(), 'previous')

    def test_generation_removes_stale_sources(self):
        self.source('400', 'A.scala', '{"spark":["400"],"includeDescendantShims":false}')
        generated = self.root / 'generated'
        stale = generated / 'main' / 'scala' / 'pkg' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        generate_sources(str(self.module), str(generated), self.graph, '400')
        self.assertFalse(stale.exists())


if __name__ == '__main__':
    unittest.main()
