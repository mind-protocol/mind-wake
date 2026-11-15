export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  tab: string | null;
  activity: string;
  at: string | null;
  detail: string;
  threadId?: string;
}
export interface GraphMessage {
  id: string;
  from: string;
  to: string;
  kind: string;
  state: string;
  at: string | null;
  text: string;
  source: string;
  correlationId: string | null;
  threadId: string | null;
  retry: unknown;
  history: { state: string; at: string | null }[];
  detail: string;
}
export interface VoiceGraph {
  version: 1;
  observedAt: string;
  tabs: { id: string; label: string }[];
  nodes: GraphNode[];
  messages: GraphMessage[];
  sources: {
    path: string;
    state: string;
    at: string | null;
    readAt: string;
    error?: string;
  }[];
  limits: string[];
}
export interface GraphSelection {
  tab: string;
  selected: string | null;
  query: string;
}
export function visibleMessages(
  graph: VoiceGraph,
  selection: GraphSelection,
): GraphMessage[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const query = selection.query.trim().toLocaleLowerCase();
  return graph.messages.filter(
    (m) =>
      (selection.tab === "all" ||
        nodes.get(m.from)?.tab === selection.tab ||
        nodes.get(m.to)?.tab === selection.tab) &&
      (!query ||
        [m.id, m.text, m.from, m.to, m.kind, m.state, m.correlationId]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
}
/** Selection survives filtering, refresh and disappearance: the inspector explains absence. */
export function selectedMessage(
  graph: VoiceGraph,
  selection: GraphSelection,
): GraphMessage | undefined {
  return graph.messages.find((m) => m.id === selection.selected);
}
