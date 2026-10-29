import { randomUUID } from "node:crypto";
interface Task {
  tool: string;
  background: boolean;
  attempts: number;
}
interface Control {
  request: string;
  tasks: string[];
  deadline: number;
}
interface Frame {
  type?: string;
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  is_backgrounded?: boolean;
  parent_tool_use_id?: string | null;
  patch?: { is_backgrounded?: boolean; status?: string };
  tasks?: { task_id: string; tool_use_id?: string }[];
  response?: { request_id?: string; subtype?: string; response?: { backgrounded?: boolean } };
}
/** Pure stream-side controller. No model calls, no child termination. */
export class ForegroundYield {
  readonly tasks = new Map<string, Task>();
  readonly notices: string[] = [];
  #control: Control | null = null;
  #idle = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly pending: () => boolean,
    readonly send: (line: string) => void,
    readonly deliverIdle: () => boolean,
  ) {}
  get hasWork(): boolean {
    return this.tasks.size > 0;
  }
  observe(line: string): void {
    let m: Frame;
    try {
      m = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    if (m === null || typeof m !== "object") return;
    if (
      m.type === "system" &&
      m.subtype === "task_started" &&
      typeof m.task_id === "string" &&
      typeof m.tool_use_id === "string"
    )
      this.tasks.set(m.task_id, {
        tool: m.tool_use_id,
        background: m.is_backgrounded === true,
        attempts: 0,
      });
    if (
      m.type === "system" &&
      m.subtype === "task_updated" &&
      typeof m.task_id === "string" &&
      this.tasks.has(m.task_id)
    ) {
      const background = m.patch?.is_backgrounded ?? m.is_backgrounded;
      if (typeof background === "boolean") this.tasks.get(m.task_id)!.background = background;
      if (["completed", "failed", "killed"].includes(m.patch?.status ?? ""))
        this.tasks.delete(m.task_id);
    }
    if (m.type === "system" && m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
      const live = new Set(m.tasks.map((t) => t.task_id));
      for (const [id, task] of this.tasks)
        if (task.background && !live.has(id)) this.tasks.delete(id);
      for (const task of m.tasks)
        if (typeof task.task_id === "string") {
          const old = this.tasks.get(task.task_id);
          this.tasks.set(
            task.task_id,
            old
              ? { ...old, background: true }
              : { tool: task.tool_use_id ?? "", background: true, attempts: 0 },
          );
        }
    }
    if (m.type === "system" && m.subtype === "task_notification" && typeof m.task_id === "string")
      this.tasks.delete(m.task_id);
    if (
      m.type === "assistant" &&
      (m.parent_tool_use_id === null || m.parent_tool_use_id === undefined)
    )
      this.#idle = false;
    if (
      m.type === "control_response" &&
      this.#control &&
      m.response?.request_id === this.#control.request
    ) {
      const observedBackground = this.#control.tasks.some(
        (id) => this.tasks.get(id)?.background === true,
      );
      if (
        m.response.subtype === "success" &&
        (m.response.response?.backgrounded === true || observedBackground)
      ) {
        for (const id of this.#control.tasks) {
          const active = this.tasks.get(id);
          if (active) active.background = true;
        }
        this.notices.push(
          "Attente libérée, travail conservé en arrière-plan ; transmission du message en cours.",
        );
      } else {
        this.notices.push(
          "Le runtime n’a pas confirmé la mise en arrière-plan ; travail laissé intact et message conservé.",
        );
      }
      this.#control = null;
    }
  }
  markIdle(): void {
    this.#idle = true;
  }
  tick(): void {
    if (!this.pending()) return;
    if (this.#control && Date.now() > this.#control.deadline) {
      this.#control = null;
      this.notices.push(
        "Pas de confirmation du runtime ; travail laissé intact et message conservé.",
      );
    }
    if (this.#idle) {
      if (this.deliverIdle()) {
        this.#idle = false;
        this.notices.push(
          "Message envoyé au runtime entre deux tours ; accusé de réception attendu, tâches conservées.",
        );
      }
      return;
    }
    if (this.#control) return;
    const entry = [...this.tasks.entries()].find(([, t]) => !t.background && t.attempts < 2);
    if (!entry) return;
    for (const active of this.tasks.values()) if (!active.background) active.attempts++;
    const request = "wake-yield-" + randomUUID();
    this.#control = {
      request,
      tasks: [...this.tasks.entries()].filter(([, t]) => !t.background).map(([id]) => id),
      deadline: Date.now() + 5000,
    };
    try {
      this.send(
        JSON.stringify({
          type: "control_request",
          request_id: request,
          request: { subtype: "background_tasks" },
        }),
      );
    } catch {
      this.#control = null;
      this.notices.push("Commande de mise en arrière-plan non transmise ; message conservé.");
    }
  }
  start(): void {
    this.#timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* Queue remains durable on temporary IO errors. */
      }
    }, 250);
    this.#timer.unref();
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
