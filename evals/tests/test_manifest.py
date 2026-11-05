"""The checked-in subset is ids and selection metadata, not the dataset."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lancer_eval.dataset import load_task_set
from lancer_eval.manifest import default_manifest_path, difficulty_heuristic, load_manifest


class ManifestTest(unittest.TestCase):
    def test_subset_is_auditable(self) -> None:
        manifest = load_manifest(default_manifest_path())
        instances = manifest["instances"]
        self.assertGreaterEqual(len(instances), 20)
        self.assertLessEqual(len(instances), 30)
        repos = {item["repo"] for item in instances}
        self.assertGreaterEqual(len(repos), 8)
        labels = {item["difficulty_heuristic"] for item in instances}
        self.assertEqual(labels, {"localized", "moderate", "broader"})
        for item in instances:
            self.assertNotIn("problem_statement", item)
            self.assertNotIn("patch", item)
            self.assertNotIn("test_patch", item)
            self.assertEqual(
                item["difficulty_heuristic"],
                difficulty_heuristic(
                    gold_patch_lines=item["gold_patch_lines"],
                    fail_to_pass_count=item["fail_to_pass_count"],
                    pass_to_pass_count=item["pass_to_pass_count"],
                    problem_statement_chars=item["problem_statement_chars"],
                ),
            )
        self.assertIn("selection", manifest)

    def test_example_business_task_set_loads(self) -> None:
        example = Path(__file__).resolve().parents[1] / "examples" / "business-task-set.example.json"
        tasks = load_task_set(example)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0].instance_id, "billing__tax-rounding-1")
        self.assertFalse(tasks[0].swebench)
        self.assertTrue(tasks[0].test_command)

    def test_task_set_requires_a_problem_statement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "instance_id": "billing__tax-rounding-1",
                                "repo": "example/billing",
                                "base_commit": "abc",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                load_task_set(path)


if __name__ == "__main__":
    unittest.main()
