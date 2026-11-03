---
name: planifier-wakes
description: Prepare or revise upcoming MIND Wake sessions, their projects, intentions and resumption context. Use at the start of a block, when a plan is missing or outdated, when direction changes, or to request resumption at a particular time. Do not load just to execute an already defined step.
---

# Plan wakes

The daemon triggers wakes; you prepare their content. In Always-on, it resumes after the main session; in scheduled mode, the scheduler chooses the time. Planning launches no model and changes neither human controls nor provider limits.

## Prepare or review a block

1. Read the assignment supplied at wake; `get_next_wakes({"count":1})` retrieves it and checks whether rotation is active. This does not reserve a series of sessions.
2. For the assigned project, call `get_wake_project({"project_id":"<id>"})`. Review its sources, results, questions and recent human decisions. A `handoff.needsReview` flag requires reading sources, not inventing a summary.
3. Choose the intended result and the uncertainty deserving the next effort. Distribute research, experiments, choices and creations; distinguish delegated assignments from the main agent’s work. Plan useful work during jobs, without mandatory waiting wakes.
4. With rotation active, call `plan_wake_block` with `project_id` and `steps`: exactly ten objects `{wake, objective, expected}`, numbered 1 to 10. The engine inserts the slot’s intention into its message. The first wake has already begun: focus on the following ones. Revise remaining intentions if a task takes longer; the counter advances per session, not per completed task.
   If the assignment includes `passageId`, add `passage_id` and `expected_revision` (revision from `get_next_wakes`). Retrieve that passage’s question, intended result and sources from the prompt or `get_wake_project.passages`. If it has no specific intentions, explicitly prepare the passage: never recycle the global project plan. On a revision conflict, reread before revising. Saved context remains the project’s context, separate from the new passage’s intended result.
5. Call `save_wake_context` with `project_id`, `summary`, `next_actions`, `open_questions`, `sources`. Save the observed result and next action before changing projects or ending the block. A plan and a resumption summary serve different purposes.

If human direction changes or the expected result no longer makes sense, return to the decisive question before detailing the plan. Record a real blocker with `set_wake_project_status({"project_id":"<id>","status":"blocked","reason":"cause and resumption condition"})`; continue other available work. Do not reactivate a paused project to fill the schedule.

## Choose the right mechanism

- **Active rotation:** use the manager’s plan and context. Its blocks contain ten wakes and its logical days fifty; these are not daily quotas. `configure_wake_rotation` changes this setting, not Wake activation: do not call it just to prepare what comes next.
- **New project:** work in `artifacts/projets/<id>/`, link deliverables from the README and register the project in the existing registry. Check the local tool contract before writing; assignment of the next slot remains with the manager.
- **Legacy Steps plan:** the registry’s `projects[id].etapes` field may still feed `nextWakeStep`. Check what is actually used; do not create a conflicting second plan or invent its schema.
- **Resume on an event or date:** read `wakeups/schema/agent-wakeup.schema.json` in the workspace, then place valid JSON in `wakeups/`. `when` accepts an `at` date, an `afterHours` delay, `fileChanged` or `quotaResetWithinHours`; `prompt` contains a short note to yourself. The delay starts at first detection, or last service for a repeat. A request does not make Always-on wait or lift a pause. Job completions already provide resumption events.

The registry, contexts and project files hold state; this skill holds only the procedure. Finish planning when the next step, expected result and resumption context are saved. Return to work instead of rereading the method at every wake. Consult the system-prompt revision skill only when the problem concerns organization or loading of the instruction system itself.
