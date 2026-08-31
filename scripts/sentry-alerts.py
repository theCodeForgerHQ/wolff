#!/usr/bin/env python3
"""Create or update the Wolff Sentry alert workflows (idempotent, by name).

    SENTRY_AUTH_TOKEN=... scripts/sentry-alerts.py [--org ajayaditya] [--host de.sentry.io]

Two workflows on the issue streams of wolff-web, wolff-api and wolff-ai, each
emailing the org owner:
  * a new issue, or a resolved issue that comes back (regression);
  * an error spike: one issue seen more than 10 times in an hour.
Sentry's workflow API (organizations/<org>/workflows/) replaced the per-project
issue-alert rules endpoint, which answers 404 on this org.
"""

import argparse
import json
import os
import sys
import urllib.request

PROJECTS = ["wolff-web", "wolff-api", "wolff-ai"]


def workflows(user_id: str, detector_ids: list[str]) -> list[dict]:
    email = {
        "logicType": "all",
        "conditions": [],
        "actions": [
            {
                "type": "email",
                "integrationId": None,
                "data": {},
                "config": {"targetType": "user", "targetIdentifier": user_id},
            }
        ],
    }

    def workflow(name: str, frequency: int, conditions: list[dict]) -> dict:
        return {
            "name": name,
            "enabled": True,
            "environment": None,
            "config": {"frequency": frequency},
            "detectorIds": detector_ids,
            "triggers": {"logicType": "any-short", "conditions": conditions},
            "actionFilters": [email],
        }

    flag = {"comparison": True, "conditionResult": True}
    return [
        workflow(
            "wolff: new or regressed issue",
            5,
            [{"type": "first_seen_event", **flag}, {"type": "regression_event", **flag}],
        ),
        workflow(
            "wolff: error spike (>10 events of an issue in 1h)",
            60,
            [
                {
                    "type": "event_frequency_count",
                    "comparison": {"interval": "1h", "value": 10},
                    "conditionResult": True,
                }
            ],
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--org", default="ajayaditya")
    parser.add_argument("--host", default="de.sentry.io")
    args = parser.parse_args()
    token = os.environ.get("SENTRY_AUTH_TOKEN")
    if not token:
        print("SENTRY_AUTH_TOKEN is required", file=sys.stderr)
        return 2
    base = f"https://{args.host}/api/0/organizations/{args.org}"

    def call(method: str, path: str, body: dict | None = None):
        # base is always an https:// URL built above, never user input.
        request = urllib.request.Request(  # noqa: S310
            base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:  # noqa: S310
            return json.load(response)

    owner = next(m for m in call("GET", "/members/") if m["role"] == "owner")
    projects = {p["slug"]: p["id"] for p in call("GET", "/projects/")}
    missing = [slug for slug in PROJECTS if slug not in projects]
    if missing:
        print(f"missing Sentry projects: {missing}", file=sys.stderr)
        return 1
    wanted_projects = {projects[slug] for slug in PROJECTS}
    detectors = [
        d["id"]
        for d in call("GET", "/detectors/")
        if d["type"] == "issue_stream" and d["projectId"] in wanted_projects
    ]
    existing = {w["name"]: w["id"] for w in call("GET", "/workflows/")}
    for wf in workflows(owner["user"]["id"], sorted(detectors)):
        if wf["name"] in existing:
            call("PUT", f"/workflows/{existing[wf['name']]}/", wf)
            print(f"updated {wf['name']} ({existing[wf['name']]})")
        else:
            created = call("POST", "/workflows/", wf)
            print(f"created {wf['name']} ({created['id']})")
    print(f"email to the owner ({owner['email']}), detectors {sorted(detectors)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
