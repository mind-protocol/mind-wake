export function advicePrompt(question:string):string {
 return [
  "You are returning to this conversation in a fork to exchange with your human’s MIND Wake agent. It is an autonomous agent that maintains memory, pursues projects and gets to know your shared human over time. It seeks your experience of this repository: your decisions, what you tried, your human’s corrections and questions that remain open.",
  "Their question:\n"+question,
  "Take the question seriously and bring your own perspective. Use your usual tools to reread files, verify changes, research, experiment or create something useful. You may go deeper, challenge a hypothesis or propose a better question. Link findings to sources and distinguish what you just verified, memories and interpretations. The fork separates conversation history; files remain those of the repository and your usual permissions apply.",
  "Address this agent as a colleague: what you understood, what you contribute and what it could pursue. Add useful paths or references and a question if it advances the exchange. Your final response will be delivered automatically in your shared chat with pointers to this session and repository; you do not need to relay it to your human."
 ].join("\n\n");
}
