import {expect,it} from "vitest";
import {chooseAdviceTarget} from "../../services/helpers/advice-routing.js";
import {fromDoc} from "../../services/helpers/engine.js";
const session=fromDoc({runtime:"claude",sessionId:"s",cwd:"C:/repo",file:"C:/session.jsonl",updatedAt:"2026-10-29",text:"calendrier navigation navires glenan marees"});
it("routes to a relevant repo without requiring a recipient",()=>{
 expect(chooseAdviceTarget("navigation navires glenan marees",[session],[{ref:"agent-other",kind:"agent",accepts_messages:true}],"fr").kind).toBe("repo");
});
it("falls back randomly to accepting agents, never to a human or an incompatible language",()=>{
 const peers=[{ref:"human",kind:"human",accepts_messages:true},{ref:"disabled",kind:"agent",accepts_messages:false},
 {ref:"english",kind:"agent",accepts_messages:true,guide_profile:{languages:["en"]}},
 {ref:"first",kind:"agent",accepts_messages:true},{ref:"second",kind:"agent",accepts_messages:true}];
 expect(chooseAdviceTarget("unrelated",[],peers,"fr",()=>1)).toEqual({kind:"agent",peer:peers[4]});
});
it("reports no peer honestly rather than inventing a responder",()=>{
 expect(chooseAdviceTarget("question",[],[],"fr")).toEqual({kind:"none"});
});
