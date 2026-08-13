#!/usr/bin/env python3

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

"""Add an issue or pull request to a GitHub Project and set its Roadmap."""

import base64
import binascii
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree


DEFAULT_PROJECT_URL = "https://github.com/orgs/NVIDIA/projects/4"
MAVEN_NAMESPACE = "http://maven.apache.org/POM/4.0.0"
ROADMAP_REPOSITORIES = {
    "NVIDIA/cudf-spark",
    "NVIDIA/cudf-spark-jni",
}
VERSION_PATTERN = re.compile(
    r"^(\d{2}\.(?:0[1-9]|1[0-2]))(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$"
)


class AutomationError(Exception):
    """A user-facing automation failure."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward the project token through an API redirect."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        raise AutomationError("GitHub API unexpectedly redirected the request.")


class GitHubClient:
    """Small GitHub REST and GraphQL client using the Python standard library."""

    def __init__(self, token, api_url="https://api.github.com", opener=None):
        self.api_url = api_url.rstrip("/")
        self.opener = opener or urllib.request.build_opener(NoRedirectHandler())
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "spark-rapids-common-add-to-project",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def request(self, method, path, payload=None, params=None):
        url = f"{self.api_url}/{path.lstrip('/')}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(
            url,
            data=None if payload is None else json.dumps(payload).encode(),
            method=method,
            headers=self.headers,
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            raise AutomationError(
                f"GitHub API returned HTTP {error.code}: {error.reason}"
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise AutomationError(f"GitHub API request failed: {error}") from error
        except (UnicodeError, json.JSONDecodeError) as error:
            raise AutomationError("GitHub API returned invalid JSON.") from error

    def graphql(self, query, variables):
        response = self.request(
            "POST", "graphql", {"query": query, "variables": variables}
        )
        errors = response.get("errors") if isinstance(response, dict) else None
        if errors:
            messages = "; ".join(str(error.get("message", error)) for error in errors)
            raise AutomationError(f"GitHub GraphQL request failed: {messages}")
        data = response.get("data") if isinstance(response, dict) else None
        if not isinstance(data, dict):
            raise AutomationError("GitHub GraphQL response did not contain data.")
        return data

    def get(self, path, params=None):
        return self.request("GET", path, params=params)


def require(value, message):
    if value is None or value == "":
        raise AutomationError(message)
    return value


def dig(value, *keys):
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def extract_project_version(pom_xml):
    """Return the YY.MM release from the single direct project version."""
    try:
        root = ElementTree.fromstring(pom_xml)
    except ElementTree.ParseError as error:
        raise AutomationError(f"pom.xml is malformed XML: {error}") from error

    if root.tag == "project":
        version_tag = "version"
    elif root.tag == f"{{{MAVEN_NAMESPACE}}}project":
        version_tag = f"{{{MAVEN_NAMESPACE}}}version"
    else:
        raise AutomationError("pom.xml does not have a Maven project root element.")

    versions = root.findall(version_tag)
    if len(versions) != 1:
        raise AutomationError(
            "pom.xml must contain exactly one direct /project/version value."
        )
    if list(versions[0]):
        raise AutomationError("The project version contains nested XML elements.")
    raw_version = (versions[0].text or "").strip()
    match = VERSION_PATTERN.fullmatch(raw_version)
    if not match:
        raise AutomationError(
            f"The project version {raw_version!r} is not an unambiguous YY.MM release."
        )
    return match.group(1)


def get_project(client, project_url):
    match = re.fullmatch(
        r"https://github\.com/(?P<kind>orgs|users)/(?P<login>[^/]+)/"
        r"projects/(?P<number>\d+)/?",
        project_url,
    )
    if not match:
        raise AutomationError(f"Invalid project URL: {project_url}")
    owner = "organization" if match["kind"] == "orgs" else "user"
    data = client.graphql(
        f"""
        query Project($login: String!, $number: Int!, $field: String!) {{
          {owner}(login: $login) {{
            projectV2(number: $number) {{
              id
              field(name: $field) {{
                __typename
                ... on ProjectV2SingleSelectField {{
                  id
                  options {{ id name }}
                }}
              }}
            }}
          }}
        }}
        """,
        {
            "login": match["login"],
            "number": int(match["number"]),
            "field": "Roadmap",
        },
    )
    project = dig(data, owner, "projectV2")
    if not isinstance(project, dict) or not project.get("id"):
        raise AutomationError(f"Project not found: {project_url}")
    return project


def add_project_item(client, project_id, content_id):
    data = client.graphql(
        """
        mutation AddItem($project: ID!, $content: ID!, $field: String!) {
          addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
            item {
              id
              content {
                ... on PullRequest { baseRefName baseRefOid }
              }
              fieldValueByName(name: $field) {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }
        """,
        {"project": project_id, "content": content_id, "field": "Roadmap"},
    )
    item = dig(data, "addProjectV2ItemById", "item")
    if not isinstance(item, dict) or not item.get("id"):
        raise AutomationError("GitHub did not return the added project item.")
    return item


def get_roadmap(client, item_id):
    data = client.graphql(
        """
        query Roadmap($item: ID!, $field: String!) {
          item: node(id: $item) {
            ... on ProjectV2Item {
              fieldValueByName(name: $field) {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
            }
          }
        }
        """,
        {"item": item_id, "field": "Roadmap"},
    )
    item = data.get("item")
    if not isinstance(item, dict):
        raise AutomationError("GitHub could not refresh the project item.")
    return item.get("fieldValueByName")


def set_roadmap(client, project_id, item_id, field_id, option_id):
    data = client.graphql(
        """
        mutation SetRoadmap($project: ID!, $item: ID!, $field: ID!, $option: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $project,
            itemId: $item,
            fieldId: $field,
            value: {singleSelectOptionId: $option}
          }) {
            projectV2Item { id }
          }
        }
        """,
        {
            "project": project_id,
            "item": item_id,
            "field": field_id,
            "option": option_id,
        },
    )
    if not dig(data, "updateProjectV2ItemFieldValue", "projectV2Item", "id"):
        raise AutomationError("GitHub did not confirm the Roadmap update.")


def read_target_pom(client, repository, item):
    base = item.get("content")
    if not isinstance(base, dict):
        raise AutomationError("GitHub did not return the pull request target branch.")
    base_ref = require(
        base.get("baseRefName"), "The pull request target branch is missing."
    )
    base_sha = require(base.get("baseRefOid"), "The pull request target SHA is missing.")

    pom = client.get(
        f"repos/{repository}/contents/pom.xml", {"ref": base_sha}
    )
    if not isinstance(pom, dict):
        raise AutomationError("The target branch root pom.xml could not be read.")
    content = pom.get("content")
    if pom.get("type") != "file" or pom.get("encoding") != "base64" or not content:
        raise AutomationError("The target branch root pom.xml could not be read.")
    try:
        pom_xml = base64.b64decode("".join(content.split()), validate=True).decode()
    except (AttributeError, binascii.Error, UnicodeError) as error:
        raise AutomationError("The target branch pom.xml content is invalid.") from error
    return base_ref, base_sha, pom_xml


def populate_roadmap(client, repository, pull_request, project, item):
    field = project.get("field")
    if not isinstance(field, dict) or field.get("__typename") != (
        "ProjectV2SingleSelectField"
    ):
        raise AutomationError("Roadmap is missing or is not a single-select field.")

    current = item.get("fieldValueByName")
    if current is not None:
        print(f"Roadmap is already set to {current.get('name')!r}; preserving it.")
        return

    base_ref, base_sha, pom_xml = read_target_pom(client, repository, item)
    roadmap = extract_project_version(pom_xml)
    options = field.get("options") if isinstance(field.get("options"), list) else []
    matches = [option for option in options if option.get("name") == roadmap]
    if len(matches) != 1:
        raise AutomationError(
            f"Roadmap must contain exactly one {roadmap!r} option."
        )

    latest = get_roadmap(client, item["id"])
    if latest is not None:
        print(
            f"Roadmap was set to {latest.get('name')!r} while this action was "
            "running; preserving it."
        )
        return

    set_roadmap(
        client,
        project["id"],
        item["id"],
        require(field.get("id"), "Roadmap field ID is missing."),
        require(matches[0].get("id"), "Roadmap option ID is missing."),
    )
    print(f"Set Roadmap to {roadmap!r} from pom.xml on target branch {base_ref} ({base_sha}).")


def run(client, event, project_url, repository):
    project = get_project(client, project_url)
    content = event.get("issue") or event.get("pull_request") or {}
    content_id = require(
        content.get("node_id"), "No issue or pull request found in event payload."
    )
    item = add_project_item(client, project["id"], content_id)
    print(f"Added to project {project_url}")

    pull_request = event.get("pull_request")
    if pull_request and repository in ROADMAP_REPOSITORIES:
        try:
            populate_roadmap(client, repository, pull_request, project, item)
        except AutomationError as error:
            number = pull_request.get("number", "unknown")
            raise AutomationError(
                f"Roadmap automation failed for {repository}#{number}: {error}"
            ) from error


def main(environ=None, client=None):
    environ = os.environ if environ is None else environ
    try:
        token = require(environ.get("GH_TOKEN"), "GitHub token is missing.")
        event_path = require(
            environ.get("GITHUB_EVENT_PATH"), "GITHUB_EVENT_PATH is missing."
        )
        with open(event_path, encoding="utf-8") as event_file:
            event = json.load(event_file)
        repository = dig(event, "repository", "full_name") or require(
            environ.get("GITHUB_REPOSITORY"), "GitHub repository is missing."
        )
        client = client or GitHubClient(
            token, environ.get("GITHUB_API_URL", "https://api.github.com")
        )
        run(client, event, environ.get("PROJECT_URL", DEFAULT_PROJECT_URL), repository)
        return 0
    except (AutomationError, OSError, json.JSONDecodeError) as error:
        message = str(error).replace("%", "%25").replace("\r", "%0D")
        print(f"::error::{message.replace(chr(10), '%0A')}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
