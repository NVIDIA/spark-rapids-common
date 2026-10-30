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
from shimpler_source_selectors import parse_selector_line, selector_membership


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

    def source(self, owner, name, selector, language='scala'):
        path = self.module / 'src' / 'main' / ('spark' + owner) / language / 'pkg' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('/*** spark-rapids-shim-json-lines\n' + selector +
                        '\nspark-rapids-shim-json-lines ***/\npackage pkg\nclass Example\n')
        return path

    def test_scans_scala_binary_version_directories(self):
        scala_212 = self.source('400', 'Only212.scala',
                                '{"spark":["400"],"carryForward":"none"}',
                                'scala-2.12')
        scala_213 = self.source('400', 'Only213.scala',
                                '{"spark":["400"],"carryForward":"none"}',
                                'scala-2.13')
        variants, skipped = scan_module_sources(str(self.module), self.graph)
        self.assertFalse(skipped)
        selected = resolve_sources(self.graph, variants, '400')
        self.assertEqual(selected['src/main/scala-2.12/pkg/Only212.scala'].physical_path,
                         str(scala_212))
        self.assertEqual(selected['src/main/scala-2.13/pkg/Only213.scala'].physical_path,
                         str(scala_213))

    def test_rejects_unexpected_source_directory(self):
        unexpected = self.module / 'src' / 'main' / 'spark400' / 'resources'
        unexpected.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'Unexpected source directory'):
            scan_module_sources(str(self.module), self.graph)

    def test_ignores_non_versioned_spark_directory(self):
        shared = self.module / 'src' / 'main' / 'spark-shared' / 'scala'
        shared.mkdir(parents=True)
        variants, skipped = scan_module_sources(str(self.module), self.graph)
        self.assertFalse(variants)
        self.assertFalse(skipped)

    def test_inherited_source_and_exact_override(self):
        base = self.source('400', 'A.scala',
                           '{"spark":["400"],"carryForward":"all"}')
        override = self.source('401', 'A.scala',
                               '{"spark":["401"],"carryForward":"none"}')
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
                             '{"spark":["330","350"],"carryForward":"all"}')
        override = self.source('351', 'Shared.scala',
                               '{"spark":["351"],"carryForward":"none"}')
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
                             '{"spark":["330","350"],"carryForward":"none"}')
        variants, skipped = scan_module_sources(str(self.module), graph)
        self.assertFalse(skipped)
        logical = 'src/main/scala/pkg/Exact.scala'
        for target in ('330', '350'):
            self.assertEqual(resolve_sources(graph, variants, target)[logical].physical_path,
                             str(source))
        for target in ('331', '351'):
            self.assertNotIn(logical, resolve_sources(graph, variants, target))

    def test_selector_requires_carry_forward_and_known_unique_roots(self):
        graph = {'330': None, '350': None}
        valid = parse_selector_line(
            '{"spark":["330","350"],"carryForward":"all"}', graph)
        self.assertEqual(valid.kind, 'descendants')
        self.assertEqual(valid.targets, ('330', '350'))
        for invalid, message in (
                ('{"spark":[],"carryForward":"all"}', 'nonempty'),
                ('{"spark":["330","330"],"carryForward":"all"}', 'Duplicate'),
                ('{"spark":["330","999"],"carryForward":"all"}', 'Unknown'),
                ('{"spark":["330","350"]}', 'carryForward value'),
                ('{"spark":["330"],"includeDescendantShims":1}',
                 'carryForward value'),
                ('{"spark":["330"],"carryForward":"sometimes"}',
                 'carryForward value'),
                ('{"spark":["330"],"carryForward":"none",'
                 '"includeDescendantShims":false}', 'Use carryForward'),
                ('{"spark":["330"],"carryForward":"all","delta":"40x"}',
                 'Unknown shim selector fields: delta'),
                ('{"spark":"330"}', 'target list'),
                ('{"spark":{"introduced":"330"}}', 'target list'),
                ('{"spark":{"only":"330"}}', 'target list')):
            with self.subTest(selector=invalid), self.assertRaisesRegex(ValueError, message):
                parse_selector_line(invalid, graph)

    def test_external_exact_targets_must_be_explicitly_allowed(self):
        selector = '{"spark":["330db"],"carryForward":"none"}'
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330db'):
            parse_selector_line(selector, self.graph)
        self.assertEqual(parse_selector_line(selector, self.graph, {'330db'}).targets,
                         ('330db',))
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 4O4'):
            parse_selector_line('{"spark":["4O4"],"carryForward":"none"}',
                                self.graph, {'330db'})
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330db'):
            parse_selector_line('{"spark":["330db"],"carryForward":"all"}',
                                self.graph, {'330db'})

    def test_shadow_preserves_allowlisted_external_targets(self):
        source = self.source('400', 'External.scala',
                             '{"spark":["330db","400"],"carryForward":"none"}')
        variants, _ = scan_module_sources(str(self.module), self.graph, {'330db'})
        candidates, non_inheritable = candidate_inherited_sources(self.graph, variants)
        self.assertEqual(non_inheritable, (str(source),))
        self.assertEqual(candidates[0].selectors[0].kind, 'exact')
        self.assertEqual(candidates[0].selectors[0].targets, ('330db', '400'))

    def test_scan_requires_external_exact_target_allowlist(self):
        self.source('400', 'External.scala',
                    '{"spark":["330db"],"carryForward":"none"}')
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330db'):
            scan_module_sources(str(self.module), self.graph)
        variants, skipped = scan_module_sources(str(self.module), self.graph, {'330db'})
        self.assertFalse(skipped)
        self.assertEqual(len(variants), 1)
        self.assertFalse(resolve_sources(self.graph, variants, '400'))
        self.assertFalse(generate_sources(str(self.module), str(self.root / 'generated'),
                                          self.graph, '400',
                                          allowed_external_targets={'330db'}))

    def test_generation_uses_inherited_source(self):
        graph = {'330': None, '331': '330', '400': None, '401': '400'}
        base = self.source('400', 'B.scala',
                           '{"spark":["330","400"],"carryForward":"all"}')
        generated = self.root / 'generated'
        selected = generate_sources(str(self.module), str(generated), graph, '401')
        logical = 'src/main/scala/pkg/B.scala'
        self.assertEqual(selected[logical].physical_path, str(base))
        self.assertEqual((generated / 'main' / 'scala' / 'pkg' / 'B.scala').resolve(), base)

    def test_generation_with_relative_module_root_has_readable_links(self):
        base = self.source('400', 'B.scala',
                           '{"spark":["400"],"carryForward":"none"}')
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

    def test_package_classifier_is_only_replaced_in_package_declaration(self):
        source = self.source('400', 'Comment.scala',
                             '{"spark":["400"],"carryForward":"none"}')
        source.write_text(source.read_text().replace(
            'package pkg',
            '// package com.nvidia.$_spark.version.classifier_.comment\npackage pkg'))
        generated = self.root / 'generated'
        generate_sources(str(self.module), str(generated), self.graph, '400')
        output = generated / 'main' / 'scala' / 'pkg' / 'Comment.scala'
        self.assertTrue(output.is_symlink())
        self.assertIn('$_spark.version.classifier_', output.read_text())

    def test_generation_rejects_symlinked_output_root(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        real_output = self.root / 'real-output'
        real_output.mkdir()
        generated = self.root / 'generated'
        generated.symlink_to(real_output, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'traverses a symlink'):
            generate_sources(str(self.module), str(generated), self.graph, '400')

    def test_closed_exact_membership_can_be_inherited(self):
        self.source('400', 'Closed.scala',
                    '{"spark":["400","401"],"carryForward":"none"}')
        variants, _ = scan_module_sources(str(self.module), self.graph)
        candidates, non_inheritable = candidate_inherited_sources(self.graph, variants)
        self.assertFalse(non_inheritable)
        self.assertEqual(candidates[0].selectors[0].kind, 'descendants')
        self.assertEqual(candidates[0].selectors[0].targets, ('400',))
        self.assertEqual(validate_legacy_shadow(self.graph, variants), ())

    def test_removed_source_keeps_exact_membership(self):
        graph = {'400': None, '401': '400', '402': '401'}
        source = self.source('400', 'Removed.scala',
                             '{"spark":["400","401"],"carryForward":"none"}')
        variants, _ = scan_module_sources(str(self.module), graph)
        candidates, non_inheritable = candidate_inherited_sources(graph, variants)
        self.assertEqual(non_inheritable, (str(source),))
        self.assertEqual(candidates[0].selectors[0].kind, 'exact')
        self.assertEqual(validate_legacy_shadow(graph, variants), (str(source),))
        self.assertFalse(resolve_sources(graph, candidates, '402'))

    def test_target_specific_logical_path_keeps_exact_membership(self):
        source = self.source('400', 'spark400/Specific.scala',
                             '{"spark":["400","401"],"carryForward":"none"}')
        variants, _ = scan_module_sources(str(self.module), self.graph)
        candidates, non_inheritable = candidate_inherited_sources(self.graph, variants)
        self.assertEqual(non_inheritable, (str(source),))
        self.assertEqual(candidates[0].selectors[0].kind, 'exact')
        self.assertEqual(validate_legacy_shadow(self.graph, variants), (str(source),))

    def test_target_specific_logical_path_rejects_authored_inheritance(self):
        for carry_forward in ('sameMinor', 'all'):
            with self.subTest(carry_forward=carry_forward):
                self.source('400', 'spark400/SparkShimServiceProvider.scala',
                            '{"spark":["400"],"carryForward":"' + carry_forward + '"}')
                with self.assertRaisesRegex(ValueError, 'versioned source paths require '
                                            'carryForward none'):
                    scan_module_sources(str(self.module), self.graph)

    def test_generation_ignores_known_inactive_introduction(self):
        self.source('330', 'Old.scala',
                    '{"spark":["330"],"carryForward":"all"}')
        current = self.source('400', 'Current.scala',
                              '{"spark":["400"],"carryForward":"none"}')
        generated = self.root / 'generated'
        with self.assertRaisesRegex(ValueError, 'Unknown Spark selector target 330'):
            generate_sources(str(self.module), str(generated), self.graph, '400')
        selected = generate_sources(str(self.module), str(generated), self.graph, '400',
                                    set(self.graph) | {'330'})
        self.assertEqual({item.physical_path for item in selected.values()}, {str(current)})

    def test_branching_lineage_and_exact_only_source(self):
        graph = {'400': None, '401': '400', '402': '400'}
        base = self.source('400', 'Base.scala',
                           '{"spark":["400"],"carryForward":"all"}')
        only = self.source('401', 'Only.scala',
                           '{"spark":["401"],"carryForward":"none"}')
        variants, skipped = scan_module_sources(str(self.module), graph)
        self.assertFalse(skipped)
        self.assertEqual(source_lineage(graph, '402'), ['402', '400'])
        self.assertEqual({source.physical_path for source in
                          resolve_sources(graph, variants, '401').values()}, {str(base), str(only)})
        self.assertEqual({source.physical_path for source in
                          resolve_sources(graph, variants, '402').values()}, {str(base)})

    def test_same_minor_carries_to_patch_but_not_next_minor(self):
        graph = {'404': None, '405': '404', '411': '404', '413': '411',
                 '414': '413', '420': '413', '421': '420', '430': '421',
                 '500': '420'}
        for owner, child, next_minor in (('404', '405', '411'),
                                         ('413', '414', '420'),
                                         ('420', '421', '430')):
            with self.subTest(owner=owner):
                name = 'Patch' + owner + '.scala'
                shared = self.source(owner, name,
                                     '{"spark":["' + owner + '"],'
                                     '"carryForward":"sameMinor"}')
                variants, _ = scan_module_sources(str(self.module), graph)
                logical = 'src/main/scala/pkg/' + name
                self.assertEqual(resolve_sources(graph, variants, owner)[logical].physical_path,
                                 str(shared))
                self.assertEqual(resolve_sources(graph, variants, child)[logical].physical_path,
                                 str(shared))
                self.assertNotIn(logical, resolve_sources(graph, variants, next_minor))
                selector = parse_selector_line('{"spark":["' + owner + '"],'
                                               '"carryForward":"sameMinor"}', graph)
                self.assertIn(child, selector_membership(graph, selector))
                self.assertNotIn(next_minor, selector_membership(graph, selector))

    def test_exact_override_remains_exact_on_next_patch(self):
        graph = {'404': None, '405': '404', '406': '405'}
        base = self.source('404', 'Value.scala',
                           '{"spark":["404"],"carryForward":"sameMinor"}')
        override = self.source('405', 'Value.scala',
                               '{"spark":["405"],"carryForward":"none"}')
        variants, _ = scan_module_sources(str(self.module), graph)
        logical = 'src/main/scala/pkg/Value.scala'
        self.assertEqual(resolve_sources(graph, variants, '405')[logical].physical_path,
                         str(override))
        self.assertEqual(resolve_sources(graph, variants, '406')[logical].physical_path,
                         str(base))

    def test_same_minor_accepts_vendor_suffixed_build_targets(self):
        graph = {'404': None, '405': '404', '405db': '405',
                 '405emr': '405', '411': '405'}
        base = self.source('404', 'Vendor.scala',
                           '{"spark":["404"],"carryForward":"sameMinor"}')
        variants, _ = scan_module_sources(str(self.module), graph)
        logical = 'src/main/scala/pkg/Vendor.scala'
        for target in ('405db', '405emr'):
            self.assertEqual(resolve_sources(graph, variants, target)[logical].physical_path,
                             str(base))
        self.assertNotIn(logical, resolve_sources(graph, variants, '411'))

    def test_shadow_requires_oracle_for_same_minor_selector(self):
        graph = {'404': None, '405': '404'}
        self.source('404', 'Patch.scala',
                    '{"spark":["404"],"carryForward":"sameMinor"}')
        variants, _ = scan_module_sources(str(self.module), graph)
        with self.assertRaisesRegex(ValueError, 'pre-conversion oracle is required'):
            validate_legacy_shadow(graph, variants)

    def test_rejects_missing_parent_and_cycle(self):
        with self.assertRaisesRegex(ValueError, 'Source parent 400 of 401 is not a build target'):
            validate_source_graph({'401': '400'})
        with self.assertRaisesRegex(ValueError, 'Source inheritance cycle'):
            validate_source_graph({'400': '401', '401': '400'})

    def test_release_profile_buildver_must_match_profile_identity(self):
        pom = self.root / 'mismatch.xml'
        pom.write_text('''<project xmlns="http://maven.apache.org/POM/4.0.0">
          <profiles><profile><id>release401</id><properties>
            <buildver>400</buildver>
          </properties></profile></profiles></project>''')
        with self.assertRaisesRegex(ValueError, 'activates buildver 401 but declares 400'):
            load_source_graph(str(pom))

    def test_release_profile_activation_must_match_profile_identity(self):
        for activation in ('<name>buildver</name><value>400</value>',
                           '<name>other</name><value>401</value>'):
            with self.subTest(activation=activation):
                pom = self.root / 'activation-mismatch.xml'
                pom.write_text('''<project xmlns="http://maven.apache.org/POM/4.0.0">
                  <profiles><profile><id>release401</id><activation><property>%s</property>
                  </activation><properties><buildver>401</buildver></properties>
                  </profile></profiles></project>''' % activation)
                with self.assertRaisesRegex(ValueError,
                                            'Profile release401 must activate buildver 401'):
                    load_source_graph(str(pom))

    def test_ambiguity_preserves_previous_generated_sources(self):
        self.source('400', 'A.scala', '{"spark":["401"],"carryForward":"none"}')
        self.source('401', 'A.scala', '{"spark":["401"],"carryForward":"none"}')
        generated = self.root / 'generated'
        previous = generated / 'main' / 'scala' / 'pkg' / 'Previous.scala'
        previous.parent.mkdir(parents=True)
        previous.write_text('previous')
        with self.assertRaisesRegex(ValueError, 'Ambiguous shim sources'):
            generate_sources(str(self.module), str(generated), self.graph, '401')
        self.assertEqual(previous.read_text(), 'previous')

    def test_generation_removes_stale_sources(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        generated = self.root / 'generated'
        stale = generated / 'main' / 'scala' / 'pkg' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        generate_sources(str(self.module), str(generated), self.graph, '400')
        self.assertFalse(stale.exists())

    def test_generation_validates_both_scopes_before_removal(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        generated = self.root / 'generated'
        previous = generated / 'main' / 'scala' / 'pkg' / 'Previous.scala'
        previous.parent.mkdir(parents=True)
        previous.write_text('previous')
        outside = self.root / 'outside'
        outside.mkdir()
        (generated / 'test').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'traverses a symlink'):
            generate_sources(str(self.module), str(generated), self.graph, '400',
                             output_root=str(self.root))
        self.assertEqual(previous.read_text(), 'previous')

    def test_generation_rejects_intermediate_output_symlink(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        outside = self.root / 'outside'
        stale = outside / 'src' / 'main' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        output = self.root / 'output'
        output.mkdir()
        (output / 'generated').symlink_to(outside, target_is_directory=True)
        generated = output / 'generated' / 'src'
        with self.assertRaisesRegex(ValueError, 'traverses a symlink'):
            generate_sources(str(self.module), str(generated), self.graph, '400',
                             output_root=str(output))
        self.assertEqual(stale.read_text(), 'stale')

    def test_generation_rejects_symlinked_output_boundary(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        outside = self.root / 'outside'
        stale = outside / 'main' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        output = self.root / 'output'
        output.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'traverses a symlink'):
            generate_sources(str(self.module), str(output), self.graph, '400',
                             output_root=str(output))
        self.assertEqual(stale.read_text(), 'stale')

    def test_generation_rejects_parent_reference_before_normalizing(self):
        self.source('400', 'A.scala', '{"spark":["400"],"carryForward":"none"}')
        output = self.root / 'output'
        output.mkdir()
        outside = self.root / 'outside'
        (outside / 'dir').mkdir(parents=True)
        stale = outside / 'victim' / 'main' / 'Stale.scala'
        stale.parent.mkdir(parents=True)
        stale.write_text('stale')
        (output / 'link').symlink_to(outside / 'dir', target_is_directory=True)
        generated = output / 'link' / '..' / 'victim'
        with self.assertRaisesRegex(ValueError, 'contains a parent reference'):
            generate_sources(str(self.module), str(generated), self.graph, '400',
                             output_root=str(output))
        self.assertEqual(stale.read_text(), 'stale')


if __name__ == '__main__':
    unittest.main()
