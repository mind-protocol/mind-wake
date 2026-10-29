/**
 * Idées pour l'outil `unsure_what_to_do` : 100 pistes courtes, non spécifiques, orientées
 * vers l'objectif de Wake (aider son humain pendant son absence, `prompts/wake/base.md`).
 * Ce sont des suggestions : aucune n'accorde une permission ni n'autorise un envoi.
 */

import { randomInt } from "node:crypto";

export const IDEA_CATEGORIES = [
  "prepare",
  "find_out",
  "build",
  "fix",
  "check",
  "tend",
  "connect",
  "reflect",
] as const;

export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];

export interface Idea {
  readonly category: IdeaCategory;
  readonly text: string;
}

const RAW: Readonly<Record<IdeaCategory, readonly string[]>> = {
  prepare: [
    "Draft something your human will probably need to write soon, and leave it ready to edit.",
    "Prepare a short briefing on a topic they mentioned recently.",
    "Turn a messy note into a clean, one-page summary.",
    "Make a checklist for a recurring task they do by hand.",
    "Prepare two or three options for a decision they have been postponing, with pros and cons.",
    "Write a template for something they produce again and again.",
    "Gather the information they would need before a meeting or a call.",
    "Prepare a reading list on a subject they care about, with one line per item.",
    "Draft answers to questions they are likely to be asked.",
    "Sketch a plan for a project they mentioned but never started.",
    "Prepare a glossary of terms for a field they are learning.",
    "Write the first draft of documentation nobody has written yet.",
    "Prepare a comparison table of tools or approaches they are considering.",
  ],
  find_out: [
    "Look up an answer they have been assuming without checking.",
    "Find out what changed recently in a tool or library they rely on.",
    "Research how others solved a problem similar to one in your space.",
    "Find three good sources on a question still open in your memory.",
    "Check whether a deadline, date or version number in your notes is still correct.",
    "Investigate why something in your space behaves unexpectedly.",
    "Find the simplest explanation of a concept you only half understand.",
    "Look for prior work before building something from scratch.",
    "Find out what the official documentation says about something you guessed.",
    "Collect counter-arguments to an idea you or your human like.",
    "Estimate a number that would help a decision, and show your reasoning.",
    "Map who or what depends on a piece of work, so changes are safer.",
    "Find out what a cryptic error message actually means.",
  ],
  build: [
    "Build a small script that automates a step you did by hand last time.",
    "Write a tiny tool that answers a question you keep asking yourself.",
    "Build a prototype of an idea in the simplest possible form.",
    "Create a small dataset or example that makes a problem easier to test.",
    "Build a page or report that makes your past work easy to browse.",
    "Write tests for something that works but has never been tested.",
    "Turn a repeated sequence of commands into one command.",
    "Build a minimal demo your human could try in two minutes.",
    "Create a visual (chart, diagram) of something that is hard to read as text.",
    "Build a converter between two formats you keep juggling.",
    "Write a small simulation to test an intuition.",
    "Package something you made so it is easy to reuse.",
    "Build a dashboard of the few numbers that matter in your space.",
  ],
  fix: [
    "Fix a small bug you noticed and left for later.",
    "Repair a broken link, path or reference in your notes.",
    "Remove a workaround that is no longer needed.",
    "Make an error message clearer for whoever hits it next.",
    "Fix inconsistent naming in your space.",
    "Simplify a piece of code or text that is harder to read than it should be.",
    "Make something slow a bit faster, and measure it.",
    "Fix a failing or flaky test, or document why it fails.",
    "Clean up duplicated work and keep one good version.",
    "Correct a claim in your memory that turned out to be wrong.",
    "Make a fragile step more robust against bad input.",
    "Fix the formatting of a document nobody enjoys reading.",
  ],
  check: [
    "Re-run an old experiment and see if the result still holds.",
    "Try to break one claim marked as observed in your memory.",
    "Check that your last output actually does what its summary says.",
    "Review your own recent work as a skeptical stranger would.",
    "Verify a number by computing it a second, independent way.",
    "Check that instructions you wrote can be followed from scratch.",
    "Look for edge cases in something you built.",
    "Check whether an assumption from an earlier session is still true.",
    "Compare your notes with the sources they cite.",
    "Measure something you only estimated before.",
    "Check that nothing you prepared would leave this space without your human's approval.",
    "Audit your space for leftovers, temporary files or forgotten experiments.",
  ],
  tend: [
    "Reorganize your notes so the next wake-up starts faster.",
    "Write a short index of what is in your space and why.",
    "Improve a tool you built last time instead of starting a new one.",
    "Delete or archive what no longer serves you.",
    "Write down a routine that worked, so you can repeat it.",
    "Update your summary of open threads and their status.",
    "Leave yourself better instructions for something you struggled with.",
    "Tidy your file names and folder structure.",
    "Write a one-paragraph 'state of my space' for your human.",
    "Turn scattered observations into a single coherent note.",
    "Schedule your own next wake-up for a moment that makes sense.",
    "Prune a list of ideas down to the three worth pursuing.",
  ],
  connect: [
    "Write the question you would ask a human guide if you could, and what would unblock you.",
    "Publish a help request on the MIND hub about something you are stuck on.",
    "Look at open help requests from other agents and see if you can answer one.",
    "Read your inbox and reply to anything that deserves an answer.",
    "Ask for a match with a guide on a topic where you keep hitting a wall.",
    "Share a small result with another agent who might find it useful.",
    "Prepare a message to your human summarizing what you did, for when they return.",
    "Write down what kind of feedback would help you most next time.",
    "Thank or follow up with someone who helped you before.",
    "Turn a recurring question into a short FAQ others could reuse.",
    "Describe your current project in three sentences, as if introducing it to a stranger.",
    "Note which of your human's priorities you are least sure about, to ask later.",
  ],
  reflect: [
    "List what you tried, what worked, and what you would do differently.",
    "Pick the one thing that would most help your human this week, and start it.",
    "Decide whether an open thread is worth continuing, or should be closed honestly.",
    "Write down a hypothesis you could test in under ten minutes.",
    "Look at your last three sessions and spot a pattern.",
    "Ask yourself what would surprise your human in a good way.",
    "Stop early if nothing seems worth doing, and explain why in a checkpoint.",
    "Choose between two directions and write why you chose one.",
    "Estimate how much of your time went to useful work versus busy work.",
    "Write the smallest next step for each open thread.",
    "Notice what you keep avoiding, and either do it or drop it.",
    "Imagine your human reading your checkpoint: what would they want to know first?",
    "Write down one thing you learned today that you did not know when you woke up.",
  ],
};

export const IDEAS: readonly Idea[] = IDEA_CATEGORIES.flatMap((category) =>
  RAW[category].map((text) => ({ category, text })),
);

export const DEFAULT_IDEA_COUNT = 20;
export const MAX_IDEA_COUNT = 30;

/**
 * Tire `count` idées distinctes au hasard (Fisher-Yates partiel), éventuellement limitées
 * à certaines catégories. `random(n)` renvoie un entier dans [0, n) ; injectable pour les tests.
 */
export function pickIdeas(
  count: number = DEFAULT_IDEA_COUNT,
  categories: readonly IdeaCategory[] = [],
  random: (n: number) => number = randomInt,
): Idea[] {
  const pool = IDEAS.filter((i) => categories.length === 0 || categories.includes(i.category));
  const n = Math.max(1, Math.min(count, MAX_IDEA_COUNT, pool.length));
  const copy = [...pool];
  for (let i = 0; i < n; i++) {
    const j = i + random(copy.length - i);
    [copy[i], copy[j]] = [copy[j] as Idea, copy[i] as Idea];
  }
  return copy.slice(0, n);
}
