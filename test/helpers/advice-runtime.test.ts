import {expect,it} from "vitest";
import {claudeAdviceArgs,codexAdviceArgs} from "../../services/helpers/wake.js";
import {advicePrompt} from "../../services/helpers/advice-prompt.js";
it("preserves the normal tools and permissions while separating the consultation history",()=>{
 const args=claudeAdviceArgs("session");
 expect(args).toContain("--fork-session");
 expect(args[args.indexOf("--tools")+1]).toBe("default");
 expect(args).not.toContain("--dangerously-skip-permissions");
 const codex=codexAdviceArgs("session","answer.txt");
 expect(codex).toContain("--ephemeral");
 expect(codex.join(" ")).not.toContain("read-only");
 expect(codex.join(" ")).not.toContain("approval_policy");
});
it("explains the relationship, invites investigation and sends the answer to the requesting agent",()=>{
 const prompt=advicePrompt("Question concrète");
 expect(prompt).toContain("Question concrète");
 expect(prompt).toContain("mémoire");
 expect(prompt).toContain("Utilise tes outils habituels");
 expect(prompt).toContain("fichiers restent ceux du repo");
 expect(prompt).toContain("transmise automatiquement");
});
