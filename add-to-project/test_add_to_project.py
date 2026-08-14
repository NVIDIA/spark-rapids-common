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

import base64
import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("add_to_project.py")
SPEC = importlib.util.spec_from_file_location("add_to_project", MODULE_PATH)
add_to_project = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(add_to_project)

AutomationError = add_to_project.AutomationError
run = add_to_project.run

PROJECT_URL = "https://github.com/orgs/NVIDIA/projects/4"
DEFAULT_POM = """\
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <version>26.08.0-SNAPSHOT</version>
</project>
"""


class FakeGitHubClient:
    def __init__(
        self,
        item_exists=True,
        roadmap=None,
        latest=None,
        pom=DEFAULT_POM,
        has_next_page=False,
        content_type="PullRequest",
        item_exists_after_add_error=None,
    ):
        self.item_exists = item_exists
        self.roadmap = roadmap
        self.latest = latest
        self.pom = pom
        self.has_next_page = has_next_page
        self.content_type = content_type
        self.item_exists_after_add_error = item_exists_after_add_error
        self.graphql_calls = []
        self.get_calls = []

    @property
    def operations(self):
        return [operation for operation, _ in self.graphql_calls]

    def graphql(self, query, variables):
        operation = next(
            name
            for name in ("Project", "AddItem", "SetRoadmap", "Roadmap")
            if f"{name}(" in query
        )
        self.graphql_calls.append((operation, variables))
        if operation == "Project":
            item = {
                "id": "ITEM",
                "project": {"id": "PROJECT"},
                "fieldValueByName": self.roadmap,
            }
            return {
                "organization": {
                    "projectV2": {
                        "id": "PROJECT",
                        "field": {
                            "__typename": "ProjectV2SingleSelectField",
                            "id": "ROADMAP_FIELD",
                            "options": [{"id": "OPTION_2608", "name": "26.08"}],
                        },
                    }
                },
                "content": {
                    "__typename": self.content_type,
                    "projectItems": {
                        "nodes": [item] if self.item_exists else [],
                        "pageInfo": {"hasNextPage": self.has_next_page},
                    },
                },
            }
        if operation == "AddItem":
            if self.item_exists_after_add_error is not None:
                self.item_exists = self.item_exists_after_add_error
                raise AutomationError("add failed")
            return {
                "addProjectV2ItemById": {
                    "item": {"id": "ITEM", "fieldValueByName": None}
                }
            }
        if operation == "Roadmap":
            return {"item": {"fieldValueByName": self.latest}}
        return {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "ITEM"}}}

    def get(self, path, params=None):
        self.get_calls.append((path, params))
        return {
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(self.pom.encode()).decode(),
        }


def merged_event(repository):
    return {
        "pull_request": {
            "node_id": "PR",
            "number": 1,
            "merged": True,
            "base": {"ref": "branch-26.08"},
            "merge_commit_sha": "MERGE_SHA",
        },
        "repository": {"full_name": repository},
    }


class AddToProjectTest(unittest.TestCase):
    def test_merged_existing_item_sets_roadmap_in_both_repositories(self):
        for repository in ("NVIDIA/cudf-spark", "NVIDIA/cudf-spark-jni"):
            with self.subTest(repository=repository):
                client = FakeGitHubClient()
                run(client, merged_event(repository), PROJECT_URL, repository)

                self.assertEqual(
                    ["Project", "Roadmap", "SetRoadmap"], client.operations
                )
                self.assertEqual(
                    [(f"repos/{repository}/contents/pom.xml", {"ref": "MERGE_SHA"})],
                    client.get_calls,
                )
                set_variables = client.graphql_calls[-1][1]
                self.assertEqual("OPTION_2608", set_variables["option"])

    def test_merged_non_target_repository_does_not_set_roadmap(self):
        repository = "NVIDIA/other"
        client = FakeGitHubClient()

        run(client, merged_event(repository), PROJECT_URL, repository)

        self.assertEqual(["Project"], client.operations)
        self.assertEqual([], client.get_calls)

    def test_existing_roadmap_is_preserved_without_reading_pom(self):
        repository = "NVIDIA/cudf-spark"
        client = FakeGitHubClient(roadmap={"name": "27.10"})

        run(client, merged_event(repository), PROJECT_URL, repository)

        self.assertEqual(["Project"], client.operations)
        self.assertEqual([], client.get_calls)

    def test_opened_content_is_added_without_setting_roadmap(self):
        for content_type, key in (("Issue", "issue"), ("PullRequest", "pull_request")):
            with self.subTest(content_type=content_type):
                client = FakeGitHubClient(
                    item_exists=False, content_type=content_type
                )
                event = {key: {"node_id": "CONTENT", "merged": False}}

                run(client, event, PROJECT_URL, "NVIDIA/cudf-spark")

                self.assertEqual(["Project", "AddItem"], client.operations)
                self.assertEqual([], client.get_calls)

    def test_ambiguous_versions_never_update_roadmap(self):
        invalid_poms = (
            "<project></project>",
            "<project><version>26.08.0</version><version>26.10.0</version></project>",
            "<project><version>${revision}</version></project>",
        )
        repository = "NVIDIA/cudf-spark"
        for pom in invalid_poms:
            with self.subTest(pom=pom):
                client = FakeGitHubClient(pom=pom)

                with self.assertRaises(AutomationError):
                    run(client, merged_event(repository), PROJECT_URL, repository)

                self.assertNotIn("SetRoadmap", client.operations)

    def test_roadmap_set_while_running_is_preserved(self):
        repository = "NVIDIA/cudf-spark"
        client = FakeGitHubClient(latest={"name": "27.10"})

        run(client, merged_event(repository), PROJECT_URL, repository)

        self.assertEqual(["Project", "Roadmap"], client.operations)

    def test_hidden_existing_item_fails_without_adding(self):
        client = FakeGitHubClient(item_exists=False, has_next_page=True)

        with self.assertRaisesRegex(AutomationError, "more than 100 projects"):
            run(client, {"pull_request": {"node_id": "PR"}}, PROJECT_URL, "repo")

        self.assertEqual(["Project"], client.operations)

    def test_duplicate_add_race_recovers_existing_item(self):
        repository = "NVIDIA/cudf-spark"
        client = FakeGitHubClient(
            item_exists=False, item_exists_after_add_error=True
        )

        run(client, merged_event(repository), PROJECT_URL, repository)

        self.assertEqual(
            ["Project", "AddItem", "Project", "Roadmap", "SetRoadmap"],
            client.operations,
        )

    def test_add_failure_is_preserved_when_item_is_still_missing(self):
        client = FakeGitHubClient(
            item_exists=False, item_exists_after_add_error=False
        )

        with self.assertRaisesRegex(AutomationError, "add failed"):
            run(client, {"issue": {"node_id": "ISSUE"}}, PROJECT_URL, "repo")

        self.assertEqual(["Project", "AddItem", "Project"], client.operations)


if __name__ == "__main__":
    unittest.main()
